import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { BetService } from '../bet/bet.service';
import { RedisService } from '../redis/redis.service';
import { WalletService } from '@vector-games/game-core';
import { GameService } from '../games/game.service';
import { Bet, BetStatus } from '@vector-games/game-core';
import { DEFAULTS } from '../../config/defaults.config';

/**
 * Scheduled service that periodically refunds bets in PLACED status
 * that are older than the Redis session TTL.
 * Runs every (Redis TTL + 2 minutes) to ensure all expired sessions are processed.
 */
@Injectable()
export class RefundSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RefundSchedulerService.name);
  private intervalTimer?: NodeJS.Timeout;
  private readonly BUFFER_MINUTES = 2; // 2 minutes buffer as requested

  constructor(
    private readonly betService: BetService,
    private readonly redisService: RedisService,
    private readonly walletService: WalletService,
    private readonly gameService: GameService,
  ) {}

  async onModuleInit() {
    await this.startScheduler();
  }

  onModuleDestroy() {
    this.stopScheduler();
  }

  /**
   * Start the refund scheduler
   * Calculates interval based on Redis session TTL + buffer
   */
  private async startScheduler(gameCode: string = 'chicken-road-two') {
    try {
      // Get session TTL in seconds, convert to milliseconds
      const sessionTTLSeconds = await this.redisService.getSessionTTL(gameCode);
      const sessionTTLMs = sessionTTLSeconds * 1000;
      const bufferMs = this.BUFFER_MINUTES * 60 * 1000;
      const intervalMs = sessionTTLMs + bufferMs;

      this.logger.log(
        `Starting refund scheduler: interval=${intervalMs}ms (TTL: ${sessionTTLMs}ms + buffer: ${bufferMs}ms)`,
      );

      // Run immediately on startup, then schedule periodic runs
      await this.processRefunds(sessionTTLMs);

      // Schedule periodic execution
      this.intervalTimer = setInterval(async () => {
        try {
          await this.processRefunds(sessionTTLMs);
        } catch (error) {
          this.logger.error(
            `Error in scheduled refund processing: ${error.message}`,
            error.stack,
          );
        }
      }, intervalMs);
    } catch (error) {
      this.logger.error(
        `Failed to start refund scheduler: ${error.message}`,
        error.stack,
      );
    }
  }

  /**
   * Stop the refund scheduler
   */
  private stopScheduler() {
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = undefined;
      this.logger.log('Refund scheduler stopped');
    }
  }

  /**
   * Process refunds for old PLACED bets
   * @param olderThanMs - Time threshold in milliseconds (Redis session TTL)
   */
  private async processRefunds(olderThanMs: number): Promise<void> {
    this.logger.debug(
      `Processing refunds for bets older than ${olderThanMs}ms`,
    );

    // Acquire distributed lock to prevent concurrent processing across multiple instances
    const lockKey = 'refund-scheduler-lock';
    const lockAcquired = await this.redisService.acquireLock(lockKey, 300); // 5 minute lock
    
    if (!lockAcquired) {
      this.logger.debug(
        'Refund scheduler lock already held by another instance, skipping this run',
      );
      return;
    }

    try {
      const oldBets = await this.betService.findOldPlacedBets(olderThanMs);

      if (oldBets.length === 0) {
        this.logger.debug('No old PLACED bets found to refund');
        return;
      }

      this.logger.log(
        `Found ${oldBets.length} old PLACED bet(s) to refund`,
      );

      // Group bets by userId and operatorId (since API requires single userId/agentId per call)
      const betsByUserAndOperator = new Map<string, Bet[]>();
      for (const bet of oldBets) {
        const key = `${bet.userId}:${bet.operatorId}`;
        if (!betsByUserAndOperator.has(key)) {
          betsByUserAndOperator.set(key, []);
        }
        betsByUserAndOperator.get(key)!.push(bet);
      }

      let successCount = 0;
      let failureCount = 0;
      let skippedCount = 0;
      const BATCH_SIZE = 5;

      // Process each user/operator group
      for (const [key, bets] of betsByUserAndOperator.entries()) {
        const [userId, operatorId] = key.split(':');
        
        // Split into batches of 5
        for (let i = 0; i < bets.length; i += BATCH_SIZE) {
          const batch = bets.slice(i, i + BATCH_SIZE);
          
          try {
            // Check if any session exists for bets in this batch
            // Only skip refund if session exists AND matches the bet's transaction ID AND is active
            const hasActiveSession = await Promise.all(
              batch.map(bet => this.sessionExistsForBet(userId, operatorId, bet.gameCode, bet.externalPlatformTxId))
            );
            if (hasActiveSession.some(active => active)) {
              skippedCount += batch.length;
              this.logger.debug(
                `Skipping refund for batch of ${batch.length} bet(s) - session still active for user ${userId}`,
              );
              continue;
            }

            await this.refundBets(batch);
            successCount += batch.length;
            this.logger.log(
              `Successfully refunded batch of ${batch.length} bet(s) for user ${userId}`,
            );
          } catch (error) {
            failureCount += batch.length;
            this.logger.error(
              `Failed to refund batch of ${batch.length} bet(s) for user ${userId}: ${error.message}`,
              error.stack,
            );
          }
        }
      }

      this.logger.log(
        `Refund processing complete: ${successCount} succeeded, ${failureCount} failed, ${skippedCount} skipped (session active)`,
      );
    } catch (error) {
      this.logger.error(
        `Error processing refunds: ${error.message}`,
        error.stack,
      );
    } finally {
      // Always release the lock, even if an error occurred
      await this.redisService.releaseLock(lockKey);
    }
  }

  /**
   * Check if a game session exists in Redis for the given user, operator, and gameCode
   * @param userId - User ID
   * @param operatorId - Operator/Agent ID
   * @param gameCode - Game code
   * @returns true if session exists, false otherwise
   * @deprecated Use sessionExistsForBet instead to check if session matches specific bet
   */
  private async sessionExists(userId: string, operatorId: string, gameCode: string): Promise<boolean> {
    try {
      const redisKey = `gameSession:${userId}-${operatorId}-${gameCode}`;
      const session = await this.redisService.get(redisKey);
      return session !== null && session !== undefined;
    } catch (error) {
      // If Redis check fails, err on the side of caution and skip refund
      this.logger.warn(
        `Failed to check session existence for user ${userId} gameCode ${gameCode}: ${error.message}. Skipping refund to prevent race condition.`,
      );
      return true; // Return true to skip refund when check fails
    }
  }

  /**
   * Check if an active game session exists in Redis for the specific bet
   * Only returns true if:
   * 1. Session exists
   * 2. Session is active (isActive === true)
   * 3. Session's platformBetTxId matches the bet's externalPlatformTxId
   * 
   * This prevents skipping refunds when:
   * - Session doesn't exist (expired)
   * - Session exists but is inactive (game finished)
   * - Session exists but is for a different bet (new bet placed)
   * 
   * @param userId - User ID
   * @param operatorId - Operator/Agent ID
   * @param gameCode - Game code
   * @param betExternalPlatformTxId - The bet's externalPlatformTxId to match against
   * @returns true if active session exists for this specific bet, false otherwise
   */
  private async sessionExistsForBet(
    userId: string,
    operatorId: string,
    gameCode: string,
    betExternalPlatformTxId: string,
  ): Promise<boolean> {
    try {
      const redisKey = `gameSession:${userId}-${operatorId}-${gameCode}`;
      const session = await this.redisService.get<any>(redisKey);
      
      // No session exists - can refund
      if (!session) {
        return false;
      }

      // Session exists but is inactive - can refund
      if (session.isActive !== true) {
        this.logger.debug(
          `Session exists but is inactive for bet ${betExternalPlatformTxId}, proceeding with refund`,
        );
        return false;
      }

      // Session exists and is active, but check if it's for this specific bet
      // If platformBetTxId doesn't match, it means it's a different bet's session
      if (session.platformBetTxId !== betExternalPlatformTxId) {
        this.logger.debug(
          `Session exists but for different bet (session: ${session.platformBetTxId}, bet: ${betExternalPlatformTxId}), proceeding with refund`,
        );
        return false;
      }

      // Session exists, is active, and matches this bet - skip refund
      this.logger.debug(
        `Active session found for bet ${betExternalPlatformTxId}, skipping refund`,
      );
      return true;
    } catch (error) {
      // If Redis check fails, err on the side of caution and skip refund
      this.logger.warn(
        `Failed to check session existence for user ${userId} gameCode ${gameCode} bet ${betExternalPlatformTxId}: ${error.message}. Skipping refund to prevent race condition.`,
      );
      return true; // Return true to skip refund when check fails
    }
  }

  /**
   * Refund a batch of bets (up to 5 bets at once)
   * @param bets - Array of bets to refund (must all belong to same user and operator)
   */
  private async refundBets(bets: Bet[]): Promise<void> {
    if (bets.length === 0) {
      return;
    }

    // All bets in batch must have same userId and operatorId
    const userId = bets[0].userId;
    const operatorId = bets[0].operatorId;

    // Note: Session existence check is now done in processRefunds() before calling this method
    // This method assumes session doesn't exist and proceeds with refund
    this.logger.log(
      `Processing refund batch of ${bets.length} bet(s) for user: ${userId}`,
    );

    // Build refund transactions array
    const refundTransactions = await Promise.all(bets.map(async (bet) => {
      const originalPlatformTxId = bet.externalPlatformTxId;
      const betAmount = Number(bet.betAmount);
      
      // Get game payloads from GameService using gameCode
      let gamePayloads;
      try {
        gamePayloads = await this.gameService.getGamePayloads(bet.gameCode);
      } catch (error) {
        this.logger.warn(
          `Failed to get game payloads for gameCode ${bet.gameCode}, using defaults: ${error.message}`,
        );
        // Fallback to defaults if game not found
        gamePayloads = {
          platform: DEFAULTS.BET.DEFAULT_PLATFORM,
          gameType: DEFAULTS.BET.DEFAULT_GAME_TYPE,
          gameCode: bet.gameCode || DEFAULTS.BET.DEFAULT_GAME_CODE,
          gameName: DEFAULTS.BET.DEFAULT_GAME_NAME,
          settleType: 'platformTxId',
        };
      }
      
      return {
        platformTxId: originalPlatformTxId,
        refundPlatformTxId: originalPlatformTxId, // Reference to original bet
        betAmount: betAmount,
        winAmount: 0, // Refund amount equals bet amount for PLACED bets
        turnover: 0, // No turnover for uncompleted bets
        betTime: bet.betPlacedAt?.toISOString() || bet.createdAt.toISOString(),
        updateTime: new Date().toISOString(),
        roundId: bet.roundId,
        gameCode: bet.gameCode, // Required for WalletService
        gameInfo: bet.gameInfo ? JSON.parse(bet.gameInfo) : undefined,
      };
    }));

    try {
      // Call refund API with all transactions in batch
      const refundResult = await this.walletService.refundBet({
        agentId: operatorId,
        userId,
        refundTransactions,
      });

      if (refundResult.status !== '0000') {
        throw new Error(
          `Agent rejected refund with status: ${refundResult.status}`,
        );
      }

      // Update all bet statuses to REFUNDED
      const updatePromises = bets.map((bet) =>
        this.betService.updateStatus({
          externalPlatformTxId: bet.externalPlatformTxId,
          status: BetStatus.REFUNDED,
          updatedBy: 'refund-scheduler',
        }),
      );

      await Promise.all(updatePromises);

      const txIds = bets.map((b) => b.externalPlatformTxId).join(', ');
      this.logger.log(
        `Successfully refunded batch of ${bets.length} bet(s): ${txIds}`,
      );
    } catch (error) {
      this.logger.error(
        `Refund failed for batch of ${bets.length} bet(s) for user ${userId}: ${error.message}`,
        error.stack,
      );
      throw error; // Re-throw to be caught by processRefunds
    }
  }
}

