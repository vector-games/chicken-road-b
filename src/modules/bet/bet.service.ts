import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, FindOptionsWhere, Repository } from 'typeorm';
import { Bet, BetStatus } from '@vector-games/game-core';
import { Difficulty } from '../../entities/bet.entity';
import { DEFAULTS } from '../../config/defaults.config';
import { GameService } from '../games/game.service';

export interface CreateBetParams {
  externalPlatformTxId: string;
  userId: string;
  roundId: string;
  difficulty: Difficulty;
  betType?: string;
  betAmount: string;
  currency: string;
  gameCode: string;
  isPremium?: boolean;
  betPlacedAt?: Date;
  balanceAfterBet?: string;
  createdBy: string;
  operatorId: string;
  // Note: This local service uses old structure, but entity now uses gameMetadata
}

export interface SettlementParams {
  externalPlatformTxId: string;
  winAmount: string;
  settleType?: string;
  settlementRefTxId?: string;
  settledAt?: Date;
  balanceAfterSettlement?: string;
  gameInfo?: string;
  updatedBy: string;
  finalCoeff?: string;
  withdrawCoeff?: string;
  fairnessData?: {
    decimal: string;
    clientSeed: string;
    serverSeed: string;
    combinedHash: string;
    hashedServerSeed: string;
  };
}

export interface UpdateBetStatusParams {
  externalPlatformTxId: string;
  status: BetStatus;
  updatedBy: string;
}

const ERROR_MESSAGES = {
  BET_EXISTS: 'Bet already exists (idempotent placement)',
  BET_NOT_FOUND: 'Bet not found',
  SETTLEMENT_NOT_FOUND: 'Bet not found for settlement',
} as const;

@Injectable()
export class BetService {
  private readonly logger = new Logger(BetService.name);

  constructor(
    @InjectRepository(Bet) private readonly repo: Repository<Bet>,
    private readonly gameService: GameService,
  ) { }

  private whereByExternalTx(
    externalPlatformTxId: string,
    gameCode?: string,
  ): FindOptionsWhere<Bet> {
    const where: FindOptionsWhere<Bet> = { externalPlatformTxId };
    if (gameCode) {
      where.gameCode = gameCode;
    }
    return where;
  }

  async createPlacement(params: CreateBetParams): Promise<Bet> {
    // Validate gameCode exists and is active
    await this.gameService.validateGame(params.gameCode);

    const existing = await this.repo.findOne({
      where: this.whereByExternalTx(params.externalPlatformTxId, params.gameCode),
    });
    if (existing) {
      this.logger.warn(
        `Duplicate bet placement attempt: ${params.externalPlatformTxId}`,
      );
      throw new ConflictException(ERROR_MESSAGES.BET_EXISTS);
    }
    const entity = this.repo.create({
      externalPlatformTxId: params.externalPlatformTxId,
      userId: params.userId,
      roundId: params.roundId,
      gameMetadata: {
        difficulty: params.difficulty,
        betType: params.betType,
      },
      betAmount: params.betAmount,
      currency: params.currency,
      gameCode: params.gameCode,
      isPremium: params.isPremium,
      betPlacedAt: params.betPlacedAt,
      balanceAfterBet: params.balanceAfterBet,
      status: BetStatus.PLACED,
      createdBy: params.createdBy,
      updatedBy: params.createdBy,
      operatorId: params.operatorId,
    });
    const saved = await this.repo.save(entity);
    this.logger.log(
      `Bet placed: ${params.externalPlatformTxId} (game: ${params.gameCode}, user: ${params.userId}, amount: ${params.betAmount})`,
    );
    return saved;
  }

  async recordSettlement(params: SettlementParams): Promise<Bet> {
    const bet = await this.repo.findOne({
      where: this.whereByExternalTx(params.externalPlatformTxId),
    });
    if (!bet) {
      this.logger.warn(
        `Settlement failed: bet not found (${params.externalPlatformTxId})`,
      );
      throw new NotFoundException(ERROR_MESSAGES.SETTLEMENT_NOT_FOUND);
    }

    // Idempotency check: if bet is already settled, return existing bet
    if (bet.status === BetStatus.WON || bet.status === BetStatus.LOST) {
      this.logger.warn(
        `Settlement idempotency: bet already settled (${params.externalPlatformTxId}, status: ${bet.status})`,
      );
      return bet; // Return existing settled bet to prevent double settlement
    }

    bet.winAmount = params.winAmount;
    bet.settlementRefTxId = params.settlementRefTxId;
    bet.settledAt = params.settledAt ?? new Date();
    bet.balanceAfterSettlement = params.balanceAfterSettlement;
    bet.gameInfo = params.gameInfo;
    bet.finalCoeff = params.finalCoeff;
    bet.withdrawCoeff = params.withdrawCoeff;
    bet.fairnessData = params.fairnessData;

    if (bet.winAmount && Number(bet.winAmount) > 0) {
      bet.status = BetStatus.WON;
    } else {
      bet.status = BetStatus.LOST;
    }

    bet.updatedBy = params.updatedBy;
    const settled = await this.repo.save(bet);
    this.logger.log(
      `Bet settled: ${params.externalPlatformTxId} (status: ${bet.status}, win: ${params.winAmount})`,
    );
    return settled;
  }

  async updateStatus(params: UpdateBetStatusParams): Promise<Bet> {
    const bet = await this.repo.findOne({
      where: this.whereByExternalTx(params.externalPlatformTxId),
    });
    if (!bet) {
      this.logger.warn(
        `Status update failed: bet not found (${params.externalPlatformTxId})`,
      );
      throw new NotFoundException(ERROR_MESSAGES.BET_NOT_FOUND);
    }
    bet.status = params.status;
    bet.updatedBy = params.updatedBy;
    return this.repo.save(bet);
  }

  async markPendingSettlement(
    externalPlatformTxId: string,
    updatedBy: string,
  ): Promise<Bet> {
    return this.updateStatus({
      externalPlatformTxId,
      status: BetStatus.PENDING_SETTLEMENT,
      updatedBy,
    });
  }

  async markSettlementFailed(
    externalPlatformTxId: string,
    updatedBy: string,
  ): Promise<Bet> {
    return this.updateStatus({
      externalPlatformTxId,
      status: BetStatus.SETTLEMENT_FAILED,
      updatedBy,
    });
  }

  async getByExternalTxId(externalPlatformTxId: string, gameCode?: string): Promise<Bet | null> {
    return this.repo.findOne({
      where: this.whereByExternalTx(externalPlatformTxId, gameCode),
    });
  }

  async findBetByRoundId(gameCode: string, roundId: string): Promise<Bet | null> {
    return this.repo.findOne({
      where: { gameCode, roundId },
    });
  }

  async findBetByPlatformTxId(gameCode: string, externalPlatformTxId: string): Promise<Bet | null> {
    return this.repo.findOne({
      where: { gameCode, externalPlatformTxId },
    });
  }

  async listUserBets(userId: string, gameCode?: string, limit: number = DEFAULTS.BET.DEFAULT_LIMIT): Promise<Bet[]> {
    const where: FindOptionsWhere<Bet> = { userId };
    if (gameCode) {
      where.gameCode = gameCode;
    }
    return this.repo.find({
      where,
      order: { createdAt: 'DESC' },
      take: limit,
    });
  }

  async listUserBetsByTimeRange(userId: string, startTime: Date, endTime: Date, gameCode?: string, limit: number = DEFAULTS.BET.DEFAULT_LIMIT): Promise<Bet[]> {
    const where: FindOptionsWhere<Bet> = { 
      userId, 
      createdAt: Between(startTime, endTime),
    };
    if (gameCode) {
      where.gameCode = gameCode;
    }
    return this.repo.find({
      where,
      order: { createdAt: 'DESC' },
      take: limit,
    });
  }

  async listByRound(gameCode: string, roundId: string): Promise<Bet[]> {
    return this.repo.find({ where: { gameCode, roundId } });
  }

  async deletePlacedBets(): Promise<number> {
    const result = await this.repo.delete({ status: BetStatus.PLACED });
    const count = result.affected || 0;
    if (count > 0) {
      this.logger.log(`Deleted ${count} placed bets`);
    }
    return count;
  }

  /**
   * Find all PLACED bets that are older than the specified time threshold
   * Checks both betPlacedAt and createdAt to handle cases where betPlacedAt might be null
   * @param olderThanMs - Time threshold in milliseconds
   * @returns Array of bets that need to be refunded
   */
  async findOldPlacedBets(olderThanMs: number): Promise<Bet[]> {
    const thresholdDate = new Date(Date.now() - olderThanMs);
    return this.repo
      .createQueryBuilder('bet')
      .where('bet.status = :status', { status: BetStatus.PLACED })
      .andWhere(
        '(bet.betPlacedAt < :threshold OR (bet.betPlacedAt IS NULL AND bet.createdAt < :threshold))',
        { threshold: thresholdDate },
      )
      .getMany();
  }

  /**
   * Delete all bets older than the specified date
   * @param beforeDate - Delete bets created before this date
   * @returns Number of bets deleted
   */
  async deleteBetsBeforeDate(beforeDate: Date): Promise<number> {
    const result = await this.repo
      .createQueryBuilder()
      .delete()
      .from(Bet)
      .where('createdAt < :beforeDate', { beforeDate })
      .execute();
    
    const count = result.affected || 0;
    this.logger.log(
      `Deleted ${count} bet(s) created before ${beforeDate.toISOString()}`,
    );
     return count;
  }
}
