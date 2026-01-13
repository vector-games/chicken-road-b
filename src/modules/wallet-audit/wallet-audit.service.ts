import {
  Injectable,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan } from 'typeorm';
import {
  WalletAudit,
  WalletAuditStatus,
  WalletApiAction,
  WalletErrorType,
} from '@vector-games/game-core';

export interface CreateWalletAuditParams {
  requestId?: string;
  agentId: string;
  userId: string;
  apiAction: WalletApiAction;
  status: WalletAuditStatus;
  requestPayload?: any;
  requestUrl?: string;
  requestMethod?: string;
  responseData?: any;
  httpStatus?: number;
  responseTime?: number;
  failureType?: WalletErrorType;
  errorMessage?: string;
  errorStack?: string;
  platformTxId?: string;
  roundId?: string;
  betAmount?: number | string;
  winAmount?: number | string;
  currency?: string;
  callbackUrl?: string;
  rawError?: string;
  retryJobId?: string;
  isRetry?: boolean;
  retryAttempt?: number;
}

@Injectable()
export class WalletAuditService {
  private readonly logger = new Logger(WalletAuditService.name);

  constructor(
    @InjectRepository(WalletAudit)
    private readonly repo: Repository<WalletAudit>,
  ) {}

  /**
   * Log audit record (non-blocking, fire-and-forget)
   * Errors are logged but don't throw to avoid breaking API calls
   */
  async logAudit(params: CreateWalletAuditParams): Promise<WalletAudit> {
    try {
      const audit = this.repo.create({
        requestId: params.requestId,
        agentId: params.agentId,
        userId: params.userId,
        apiAction: params.apiAction,
        status: params.status,
        requestPayload: params.requestPayload,
        requestUrl: params.requestUrl,
        requestMethod: params.requestMethod || 'POST',
        responseData: params.responseData,
        httpStatus: params.httpStatus,
        responseTime: params.responseTime,
        failureType: params.failureType,
        errorMessage: params.errorMessage,
        errorStack: params.errorStack,
        platformTxId: params.platformTxId,
        roundId: params.roundId,
        betAmount: params.betAmount ? String(params.betAmount) : undefined,
        winAmount: params.winAmount ? String(params.winAmount) : undefined,
        currency: params.currency,
        callbackUrl: params.callbackUrl,
        rawError: params.rawError,
        retryJobId: params.retryJobId,
        isRetry: params.isRetry || false,
        retryAttempt: params.retryAttempt,
        resolved: false,
      });

      const saved = await this.repo.save(audit);
      this.logger.debug(
        `Wallet audit logged: ${params.apiAction} - ${params.status} for user ${params.userId} agent ${params.agentId}`,
      );
      return saved;
    } catch (err) {
      this.logger.error(
        `Failed to log wallet audit: ${err.message}`,
        err.stack,
      );
      throw err;
    }
  }

  /**
   * Mark audit record as success (for retry scenarios)
   */
  async markSuccess(
    id: string,
    responseData?: any,
  ): Promise<WalletAudit | null> {
    try {
      const audit = await this.repo.findOne({ where: { id } });
      if (!audit) {
        this.logger.warn(`Wallet audit not found: ${id}`);
        return null;
      }

      audit.status = WalletAuditStatus.SUCCESS;
      if (responseData) {
        audit.responseData = responseData;
      }
      audit.resolved = true;
      audit.resolvedAt = new Date();

      return await this.repo.save(audit);
    } catch (err) {
      this.logger.error(
        `Failed to mark audit as success: ${err.message}`,
        err.stack,
      );
      throw err;
    }
  }

  async findById(id: string): Promise<WalletAudit | null> {
    return this.repo.findOne({ where: { id } });
  }

  async findByRequestId(requestId: string): Promise<WalletAudit | null> {
    return this.repo.findOne({ where: { requestId } });
  }

  async findByPlatformTxId(
    platformTxId: string,
  ): Promise<WalletAudit[]> {
    return this.repo.find({
      where: { platformTxId },
      order: { createdAt: 'DESC' },
    });
  }

  async findByUser(
    userId: string,
    agentId?: string,
    limit = 50,
  ): Promise<WalletAudit[]> {
    const where: any = { userId };
    if (agentId) {
      where.agentId = agentId;
    }
    return this.repo.find({
      where,
      order: { createdAt: 'DESC' },
      take: limit,
    });
  }

  async findFailures(limit = 100): Promise<WalletAudit[]> {
    return this.repo.find({
      where: { status: WalletAuditStatus.FAILURE, resolved: false },
      order: { createdAt: 'DESC' },
      take: limit,
    });
  }

  /**
   * Delete records older than specified date
   * Used by cleanup scheduler
   */
  async deleteOlderThan(cutoffDate: Date): Promise<number> {
    try {
      const result = await this.repo.delete({
        createdAt: LessThan(cutoffDate),
      });
      this.logger.log(
        `Deleted ${result.affected || 0} wallet audit records older than ${cutoffDate.toISOString()}`,
      );
      return result.affected || 0;
    } catch (err) {
      this.logger.error(
        `Failed to delete old wallet audit records: ${err.message}`,
        err.stack,
      );
      throw err;
    }
  }

  /**
   * Get audit statistics
   */
  async getAuditStats(
    agentId?: string,
    startDate?: Date,
    endDate?: Date,
  ): Promise<{
    total: number;
    success: number;
    failure: number;
    byAction: Record<string, number>;
    avgResponseTime: number;
  }> {
    const query = this.repo.createQueryBuilder('audit');

    if (agentId) {
      query.where('audit.agentId = :agentId', { agentId });
    }

    if (startDate) {
      query.andWhere('audit.createdAt >= :startDate', { startDate });
    }

    if (endDate) {
      query.andWhere('audit.createdAt <= :endDate', { endDate });
    }

    const total = await query.getCount();

    const success = await query
      .andWhere('audit.status = :status', { status: WalletAuditStatus.SUCCESS })
      .getCount();

    const failure = await query
      .andWhere('audit.status = :status', { status: WalletAuditStatus.FAILURE })
      .getCount();

    const byAction = await query
      .select('audit.apiAction', 'apiAction')
      .addSelect('COUNT(*)', 'count')
      .groupBy('audit.apiAction')
      .getRawMany();

    const avgResponseTime = await query
      .select('AVG(audit.responseTime)', 'avgTime')
      .where('audit.responseTime IS NOT NULL')
      .getRawOne();

    return {
      total,
      success,
      failure,
      byAction: byAction.reduce((acc, row) => {
        acc[row.apiAction] = parseInt(row.count, 10);
        return acc;
      }, {} as Record<string, number>),
      avgResponseTime: avgResponseTime?.avgTime
        ? parseFloat(avgResponseTime.avgTime)
        : 0,
    };
  }
}

