import {
  Injectable,
  Logger,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { WalletRetryJob, WalletRetryJobStatus, BetStatus, WalletApiAction } from '@vector-games/game-core';
import { SingleWalletFunctionsService } from '../../routes/single-wallet-functions/single-wallet-functions.service';
import { BetService } from '../bet/bet.service';
import { WalletAuditService } from '../wallet-audit/wallet-audit.service';
import { WalletRetryJobService, calculateNextRetryTime } from './wallet-retry-job.service';

export interface RetryResult {
  success: boolean;
  status?: string;
  responseData?: any;
  errorMessage?: string;
  httpStatus?: number;
}

@Injectable()
export class WalletRetryProcessorService {
  private readonly logger = new Logger(WalletRetryProcessorService.name);

  constructor(
    @Inject(forwardRef(() => SingleWalletFunctionsService))
    private readonly singleWalletFunctionsService: SingleWalletFunctionsService,
    private readonly betService: BetService,
    @Inject(forwardRef(() => WalletAuditService))
    private readonly walletAuditService: WalletAuditService,
    private readonly retryJobService: WalletRetryJobService,
  ) {}

  /**
   * Execute a retry job
   */
  async executeRetry(retryJob: WalletRetryJob): Promise<RetryResult> {
    this.logger.log(
      `Executing retry: ${retryJob.id} attempt=${retryJob.retryAttempt + 1} apiAction=${retryJob.apiAction} txId=${retryJob.platformTxId}`,
    );

    try {
      let result: RetryResult;

      if (retryJob.apiAction === WalletApiAction.SETTLE_BET) {
        result = await this.executeSettleBetRetry(retryJob);
      } else if (retryJob.apiAction === WalletApiAction.REFUND_BET) {
        result = await this.executeRefundBetRetry(retryJob);
      } else {
        throw new Error(`Unsupported retry action: ${retryJob.apiAction}`);
      }

      return result;
    } catch (error: any) {
      this.logger.error(
        `Retry execution failed: ${retryJob.id} error=${error.message}`,
        error.stack,
      );
      return {
        success: false,
        errorMessage: error.message,
      };
    }
  }

  /**
   * Execute settle bet retry
   */
  private async executeSettleBetRetry(
    retryJob: WalletRetryJob,
  ): Promise<RetryResult> {
    const {
      agentId,
      userId,
      platformTxId,
      winAmount,
      betAmount,
      roundId,
      gamePayloads,
    } = retryJob;

    try {
      const settleResult = await this.singleWalletFunctionsService.settleBet(
        agentId,
        platformTxId,
        userId,
        parseFloat(winAmount || '0'),
        roundId || '',
        parseFloat(betAmount || '0'),
        gamePayloads || {},
      );

      if (settleResult.status === '0000') {
        // Success
        this.logger.log(
          `Settle bet retry succeeded: ${retryJob.id} txId=${platformTxId}`,
        );

        // Update BET status
        try {
          await this.betService.recordSettlement({
            externalPlatformTxId: platformTxId,
            winAmount: String(winAmount),
            settleType: gamePayloads?.settleType,
            settledAt: new Date(),
            balanceAfterSettlement: String(settleResult.balance),
            updatedBy: userId,
          });
        } catch (betError) {
          this.logger.error(
            `Failed to update BET after retry success: ${betError.message}`,
          );
        }

        // Update WalletAudit if exists
        if (retryJob.walletAuditId) {
          try {
            await this.walletAuditService.markSuccess(
              retryJob.walletAuditId,
              settleResult.raw,
            );
          } catch (auditError) {
            this.logger.error(
              `Failed to update WalletAudit after retry success: ${auditError.message}`,
            );
          }
        }

        return {
          success: true,
          status: settleResult.status,
          responseData: settleResult.raw,
        };
      } else {
        // Agent rejected
        return {
          success: false,
          status: settleResult.status,
          responseData: settleResult.raw,
          errorMessage: `Agent rejected with status: ${settleResult.status}`,
        };
      }
    } catch (error: any) {
      return {
        success: false,
        errorMessage: error.message,
        httpStatus: error.response?.status,
      };
    }
  }

  /**
   * Execute refund bet retry
   */
  private async executeRefundBetRetry(
    retryJob: WalletRetryJob,
  ): Promise<RetryResult> {
    const {
      agentId,
      userId,
      platformTxId,
      betAmount,
      winAmount,
      roundId,
      gamePayloads,
      requestPayload,
    } = retryJob;

    try {
      // Reconstruct refund transactions from requestPayload
      // requestPayload contains: { messageObj, url, payload, refundTransactions }
      let refundTransactions: any[];
      
      if (requestPayload?.refundTransactions) {
        // Use stored refundTransactions if available
        refundTransactions = requestPayload.refundTransactions;
      } else {
        // Fallback: build from retry job data
        refundTransactions = [
          {
            platformTxId,
            refundPlatformTxId: `refund-${platformTxId}-${Date.now()}`,
            betAmount: parseFloat(betAmount || '0'),
            winAmount: parseFloat(winAmount || '0'),
            turnover: 0,
            betTime: new Date().toISOString(),
            updateTime: new Date().toISOString(),
            roundId: roundId || '',
            gamePayloads: gamePayloads || {},
          },
        ];
      }

      const refundResult =
        await this.singleWalletFunctionsService.refundBet(
          agentId,
          userId,
          refundTransactions,
        );

      if (refundResult.status === '0000') {
        // Success
        this.logger.log(
          `Refund bet retry succeeded: ${retryJob.id} txId=${platformTxId}`,
        );

        // Update BET status
        try {
          await this.betService.updateStatus({
            externalPlatformTxId: platformTxId,
            status: BetStatus.REFUNDED,
            updatedBy: userId,
          });
        } catch (betError) {
          this.logger.error(
            `Failed to update BET after retry success: ${betError.message}`,
          );
        }

        // Update WalletAudit if exists
        if (retryJob.walletAuditId) {
          try {
            await this.walletAuditService.markSuccess(
              retryJob.walletAuditId,
              refundResult.raw,
            );
          } catch (auditError) {
            this.logger.error(
              `Failed to update WalletAudit after retry success: ${auditError.message}`,
            );
          }
        }

        return {
          success: true,
          status: refundResult.status,
          responseData: refundResult.raw,
        };
      } else {
        // Agent rejected
        return {
          success: false,
          status: refundResult.status,
          responseData: refundResult.raw,
          errorMessage: `Agent rejected with status: ${refundResult.status}`,
        };
      }
    } catch (error: any) {
      return {
        success: false,
        errorMessage: error.message,
        httpStatus: error.response?.status,
      };
    }
  }
}

