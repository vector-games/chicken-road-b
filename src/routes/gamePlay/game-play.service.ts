import { Injectable, Logger } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { v4 as uuidv4 } from 'uuid';
import { BetService } from '@vector-games/game-core';
import { BetPayloadDto, Difficulty } from './DTO/bet-payload.dto';

import { FairnessService } from '../../modules/fairness/fairness.service';
import { GameConfigService } from '../../modules/gameConfig/game-config.service';
import { HazardSchedulerService } from '../../modules/hazard/hazard-scheduler.service';
import { RedisService } from '../../modules/redis/redis.service';
import { GameService } from '../../modules/games/game.service';
import { WalletService } from '@vector-games/game-core';

import { DEFAULTS } from '../../config/defaults.config';

interface GameSession {
  userId: string;
  agentId: string;
  currency: string;
  difficulty: Difficulty;
  serverSeed?: string;
  userSeed?: string;
  hashedServerSeed?: string;
  nonce?: number;
  coefficients: string[];
  currentStep: number;
  winAmount: number;
  betAmount: number;
  isActive: boolean;
  isWin: boolean;
  createdAt: Date;
  collisionColumns?: number[];
  platformBetTxId: string;
  roundId: string;
  gameCode: string;
}

export interface BetStepResponse {
  isFinished: boolean;
  coeff: string;
  winAmount: string;
  difficulty: string;
  betAmount: string;
  currency: string;
  lineNumber?: number;
  isWin?: boolean;
  endReason?: string;
  collisionPositions?: number[];
}

type GameConfigPayload =
  {
    betConfig: Record<string, any>;
    coefficients: Record<string, any>;
    lastWin: { username: string; winAmount: string; currency: string };
  }

const GAME_CONSTANTS = {
  TOTAL_COLUMNS: DEFAULTS.hazardConfig.totalColumns,
  HAZARD_REFRESH_MS: DEFAULTS.hazardConfig.hazardRefreshMs,
  DECIMAL_PLACES: DEFAULTS.GAME.DECIMAL_PLACES,
  INITIAL_STEP: DEFAULTS.GAME.INITIAL_STEP,
  PLATFORM_NAME: DEFAULTS.GAME.PLATFORM_NAME,
  GAME_TYPE: DEFAULTS.GAME.GAME_TYPE,
  GAME_CODE: DEFAULTS.GAME.GAME_CODE,
  GAME_NAME: DEFAULTS.GAME.GAME_NAME,
} as const;

const HAZARD_CONFIG = {
  [Difficulty.EASY]: DEFAULTS.hazardConfig.hazards.EASY,
  [Difficulty.MEDIUM]: DEFAULTS.hazardConfig.hazards.MEDIUM,
  [Difficulty.HARD]: DEFAULTS.hazardConfig.hazards.HARD,
  [Difficulty.DAREDEVIL]: DEFAULTS.hazardConfig.hazards.DAREDEVIL,
} as const;

const ERROR_MESSAGES = DEFAULTS.ERROR_MESSAGES;

@Injectable()
export class GamePlayService {
  private logger = new Logger(GamePlayService.name);

  private readonly DEFAULT_CONFIG = {
    totalColumns: DEFAULTS.hazardConfig.totalColumns,
    hazardRefreshMs: DEFAULTS.hazardConfig.hazardRefreshMs,
    hazards: HAZARD_CONFIG,
  };

  constructor(
    private readonly gameConfigService: GameConfigService,
    private readonly redisService: RedisService,
    private readonly walletService: WalletService,
    private readonly betService: BetService,
    private readonly hazardSchedulerService: HazardSchedulerService,
    private readonly fairnessService: FairnessService,
    private readonly gameService: GameService,
  ) { }

  async performBetFlow(
    userId: string,
    agentId: string,
    gameCode: string,
    incoming: any,
  ): Promise<BetStepResponse | { error: string; details?: any[] }> {

    // Acquire distributed lock to prevent concurrent bet placement
    const lockKey = `bet-lock:${userId}-${agentId}`;
    const lockAcquired = await this.redisService.acquireLock(lockKey, 30); // 30 second lock
    
    if (!lockAcquired) {
      this.logger.warn(
        `Concurrent bet placement attempt blocked: user=${userId} agent=${agentId}`,
      );
      return { error: ERROR_MESSAGES.ACTIVE_SESSION_EXISTS };
    }

    try {
      const redisKey = this.getRedisKey(userId, agentId, gameCode);
      const existingSession: GameSession =
        await this.redisService.get<any>(redisKey);

      if (existingSession && existingSession.isActive) {
        this.logger.warn(
          `User ${userId} attempted to place bet while having active session`,
        );
        return { error: ERROR_MESSAGES.ACTIVE_SESSION_EXISTS };
      }

    const dto = plainToInstance(BetPayloadDto, incoming);
    const errors = await validate(dto, { whitelist: true });
    if (errors.length) {
      return {
        error: ERROR_MESSAGES.VALIDATION_FAILED,
        details: errors.map((e) => Object.values(e.constraints || {})),
      };
    }

    const betNumber = parseFloat(dto.betAmount);
    if (!isFinite(betNumber) || betNumber <= 0) {
      this.logger.warn(
        `Invalid bet amount: user=${userId} amount=${dto.betAmount}`,
      );
      return { error: ERROR_MESSAGES.INVALID_BET_AMOUNT };
    }
    const betAmountStr = betNumber.toFixed(GAME_CONSTANTS.DECIMAL_PLACES);

    const difficultyUC = dto.difficulty;
    const currencyUC = dto.currency.toUpperCase();

    const roundId = `${userId}${Date.now()}`;
    const platformTxId = `${uuidv4()}`;

    this.logger.log(
      `[BET_PLACED] user=${userId} agent=${agentId} amount=${betAmountStr} currency=${currencyUC} difficulty=${difficultyUC} roundId=${roundId} txId=${platformTxId}`,
    );

    this.logger.debug(
      `Calling wallet API placeBet: user=${userId} agent=${agentId} amount=${betNumber} roundId=${roundId}`,
    );
    // WalletService automatically gets gamePayloads via WalletApiAdapter (GameService)
    const agentResult = await this.walletService.placeBet({
      agentId,
      userId,
      amount: betNumber,
      roundId,
      platformTxId,
      currency: currencyUC,
      gameCode,
    });

    if (agentResult.status !== '0000') {
      this.logger.error(
        `Agent rejected bet: user=${userId} agent=${agentId} status=${agentResult.status} amount=${betAmountStr}`,
      );
      return { error: ERROR_MESSAGES.AGENT_REJECTED };
    }

    const {
      status,
      balance,
      balanceTs,
      userId: returnedUserId,
      raw,
    } = agentResult;

    const externalPlatformTxId = platformTxId;

    this.logger.debug(
      `Creating bet record in DB: user=${userId} txId=${externalPlatformTxId} roundId=${roundId}`,
    );
    await this.betService.createPlacement({
      externalPlatformTxId,
      userId,
      roundId,
      gameMetadata: {
        difficulty: dto.difficulty as string,
      },
      betAmount: betAmountStr,
      currency: currencyUC,
      gameCode,
      isPremium: false,
      betPlacedAt: balanceTs ? new Date(balanceTs) : undefined,
      balanceAfterBet: balance ? String(balance) : undefined,
      createdBy: userId,
      operatorId: agentId,
    });

    const cfgPayload = await this.getGameConfigPayload(gameCode);
    const coefficients = cfgPayload.coefficients || {};
    const coeffArray: string[] = coefficients[difficultyUC] || [];

    if (!coeffArray || coeffArray.length === 0) {
      this.logger.error(
        `No coefficients found for difficulty ${difficultyUC} user=${userId}`,
      );
      return { error: ERROR_MESSAGES.INVALID_DIFFICULTY_CONFIG };
    }

    this.logger.debug(
      `Loaded coefficients for difficulty ${difficultyUC}: ${coeffArray.length} steps`,
    );

    // Retrieve fairness seeds for this bet
    const fairnessData = await this.fairnessService.getOrCreateFairness(
      userId,
      agentId,
    );

    const session: GameSession = {
      userId,
      agentId,
      difficulty: difficultyUC as Difficulty,
      betAmount: betNumber,
      currency: currencyUC,
      currentStep: GAME_CONSTANTS.INITIAL_STEP,
      isActive: true,
      isWin: false,
      winAmount: betNumber,
      coefficients: coeffArray,
      createdAt: new Date(),
      platformBetTxId: externalPlatformTxId,
      roundId,
      userSeed: fairnessData.userSeed,
      serverSeed: fairnessData.serverSeed,
      hashedServerSeed: fairnessData.hashedServerSeed,
      nonce: fairnessData.nonce,
      gameCode,
    };
    this.logger.debug(
      `Creating game session in Redis: user=${userId} agent=${agentId} key=${redisKey} step=${session.currentStep}`,
    );
    const sessionTTL = await this.redisService.getSessionTTL(gameCode);
    await this.redisService.set(redisKey, session, sessionTTL);

    const resp: BetStepResponse = {
      isFinished: false,
      coeff: DEFAULTS.GAME.DEFAULT_COEFF,
      winAmount: betAmountStr,
      difficulty: difficultyUC,
      betAmount: betAmountStr,
      currency: currencyUC,
      lineNumber: GAME_CONSTANTS.INITIAL_STEP,
    };

    // Bet placement already logged above

    return resp;
    } finally {
      // Always release the lock, even if an error occurred
      await this.redisService.releaseLock(lockKey);
    }
  }

  async performStepFlow(
    userId: string,
    agentId: string,
    gameCode: string,
    lineNumber: number,
  ): Promise<BetStepResponse | { error: string }> {
    const redisKey = this.getRedisKey(userId, agentId, gameCode);
    this.logger.debug(
      `Step flow initiated: user=${userId} agent=${agentId} lineNumber=${lineNumber} key=${redisKey}`,
    );

    const gameSession: GameSession = await this.redisService.get<any>(redisKey);

    if (!gameSession || !gameSession.isActive) {
      this.logger.warn(
        `No active session for step: user=${userId} agent=${agentId} lineNumber=${lineNumber}`,
      );
      return { error: ERROR_MESSAGES.NO_ACTIVE_SESSION };
    }

    // Validate session state consistency
    if (!gameSession.coefficients || gameSession.coefficients.length === 0) {
      this.logger.error(
        `Invalid session state: missing coefficients user=${userId} agent=${agentId}`,
      );
      return { error: ERROR_MESSAGES.NO_ACTIVE_SESSION };
    }

    if (typeof gameSession.currentStep !== 'number' || gameSession.currentStep < GAME_CONSTANTS.INITIAL_STEP) {
      this.logger.error(
        `Invalid session state: invalid currentStep user=${userId} agent=${agentId} step=${gameSession.currentStep}`,
      );
      return { error: ERROR_MESSAGES.NO_ACTIVE_SESSION };
    }

    const totalColumns = gameSession.coefficients.length;
    const expected = gameSession.currentStep + 1;

    if (lineNumber !== expected) {
      this.logger.warn(
        `Invalid step sequence: user=${userId} expected=${expected} received=${lineNumber} currentStep=${gameSession.currentStep}`,
      );
      return { error: ERROR_MESSAGES.INVALID_STEP_SEQUENCE };
    }

    this.logger.debug(
      `Step validation passed: user=${userId} currentStep=${gameSession.currentStep} nextStep=${lineNumber} totalColumns=${totalColumns}`,
    );

    let endReason: 'win' | 'cashout' | 'hazard' | undefined;
    let hazardColumns: number[] = [];

    if (lineNumber === totalColumns - 1) {
      gameSession.currentStep = lineNumber;
      gameSession.winAmount =
        gameSession.betAmount *
        Number(gameSession.coefficients[gameSession.currentStep]);

      gameSession.isActive = false;
      gameSession.isWin = true;
      endReason = 'win';
      this.logger.log(
        `[GAME_STEP] user=${userId} agent=${agentId} step=${lineNumber} multiplier=${gameSession.coefficients[gameSession.currentStep]} winAmount=${gameSession.winAmount} hitHazard=false endReason=win`,
      );
    } else {
      // Get active hazard columns from scheduler
      hazardColumns = await this.hazardSchedulerService.getActiveHazards(
        gameCode,
        gameSession.difficulty,
      );

      this.logger.log(
        `Step check: user=${userId} line=${lineNumber} difficulty=${gameSession.difficulty} hazards=[${hazardColumns.join(',')}]`,
      );

      const hitHazard = hazardColumns.includes(lineNumber);

      if (!hitHazard) {
        gameSession.currentStep = lineNumber;
        gameSession.winAmount =
          gameSession.betAmount *
          Number(gameSession.coefficients[gameSession.currentStep]);
        this.logger.log(
          `[GAME_STEP] user=${userId} agent=${agentId} step=${gameSession.currentStep} multiplier=${gameSession.coefficients[gameSession.currentStep]} winAmount=${gameSession.winAmount} hitHazard=false`,
        );
      } else {
        gameSession.isActive = false;
        gameSession.isWin = false;
        gameSession.winAmount = 0;
        gameSession.collisionColumns = hazardColumns;
        gameSession.currentStep = lineNumber;
        endReason = 'hazard';
        this.logger.log(
          `[GAME_STEP] user=${userId} agent=${agentId} step=${lineNumber} multiplier=0 winAmount=0 hitHazard=true endReason=hazard`,
        );
      }
    }
    const currentMultiplier =
      gameSession.currentStep >= 0
        ? Number(gameSession.coefficients[gameSession.currentStep])
        : 0;

    // Validate session state before saving
    if (!gameSession.platformBetTxId || !gameSession.roundId) {
      this.logger.error(
        `Invalid session state: missing platformBetTxId or roundId user=${userId} agent=${agentId}`,
      );
      return { error: ERROR_MESSAGES.NO_ACTIVE_SESSION };
    }

    const sessionTTL = await this.redisService.getSessionTTL(gameCode);
    await this.redisService.set(redisKey, gameSession, sessionTTL);

    let settlementAmount = 0;
    if (endReason === 'hazard') {
      settlementAmount = DEFAULTS.GAME.SETTLEMENT_AMOUNT_ZERO;
    } else if (endReason === 'win') {
      settlementAmount = gameSession.winAmount;
    }
    if (endReason === 'win' || endReason === 'hazard') {
      try {
        // WalletService automatically gets gamePayloads via WalletApiAdapter (GameService)
        const settleResult = await this.walletService.settleBet({
          agentId: gameSession.agentId,
          platformTxId: gameSession.platformBetTxId,
          userId,
          winAmount: settlementAmount,
          roundId: gameSession.roundId,
          betAmount: parseFloat(gameSession.betAmount.toString()),
          gameCode,
          gameSession,
        });

        this.logger.log(
          `Settlement success: user=${userId} balance=${settleResult.balance} status=${settleResult.status} settlementAmount=${settlementAmount} txId=${gameSession.platformBetTxId}`,
        );

        const betAmountNum = parseFloat(gameSession.betAmount.toString());
        const winAmountNum = settlementAmount;
        const withdrawCoeff = betAmountNum > 0 && winAmountNum > 0
          ? (winAmountNum / betAmountNum).toFixed(3)
          : '0';
        const finalCoeff = gameSession.currentStep >= 0
          ? gameSession.coefficients[gameSession.currentStep]
          : '0';
        
        // Generate fairness data using seeds from game session
        const fairnessData = this.generateFairnessData(
          gameSession.userSeed,
          gameSession.serverSeed,
          gameSession.roundId,
        );

        this.logger.debug(
          `Updating bet record with settlement: user=${userId} txId=${gameSession.platformBetTxId} winAmount=${settlementAmount.toFixed(GAME_CONSTANTS.DECIMAL_PLACES)}`,
        );
        await this.betService.recordSettlement({
          externalPlatformTxId: gameSession.platformBetTxId,
          winAmount: settlementAmount.toFixed(GAME_CONSTANTS.DECIMAL_PLACES),
          settledAt: new Date(),
          balanceAfterSettlement: settleResult.balance
            ? String(settleResult.balance)
            : undefined,
          updatedBy: userId,
          finalCoeff,
          withdrawCoeff,
          fairnessData,
        });

        // Rotate seeds after successful settlement
        try {
          await this.fairnessService.rotateSeeds(userId, agentId);
        } catch (rotateError) {
          this.logger.warn(
            `Failed to rotate seeds after settlement: user=${userId} agent=${agentId} error=${rotateError.message}`,
          );
          // Don't fail settlement if seed rotation fails
        }

        // Delete session from Redis after successful settlement (bet is now WON or LOST)
        try {
          await this.redisService.del(redisKey);
          this.logger.debug(
            `Deleted game session from Redis after settlement: user=${userId} txId=${gameSession.platformBetTxId}`,
          );
        } catch (deleteError) {
          this.logger.warn(
            `Failed to delete session after settlement: user=${userId} txId=${gameSession.platformBetTxId} error=${deleteError.message}`,
          );
          // Don't fail settlement if session deletion fails
        }
      } catch (error: any) {
        this.logger.error(
          `Settlement failed: user=${userId} txId=${gameSession.platformBetTxId}`,
          error,
        );

        // Error already logged in singleWalletFunctionsService.settleBet() with full details
        // (requestId, responseTime, httpStatus, etc.) and retry job already created
        // No need to log again here to avoid duplicate entries

        throw new Error(ERROR_MESSAGES.SETTLEMENT_FAILED);
      }
    }

    return this.sendStepResponse(
      gameSession.isActive,
      gameSession.isWin,
      gameSession.currentStep,
      gameSession.winAmount,
      gameSession.betAmount,
      endReason === 'hazard' ? 0 : currentMultiplier,
      gameSession.difficulty,
      gameSession.currency,
      endReason,
      endReason === 'hazard' ? hazardColumns : undefined,
    );
  }

  async performCashOutFlow(
    userId: string,
    agentId: string,
    gameCode: string,
  ): Promise<BetStepResponse | { error: string }> {
    const redisKey = this.getRedisKey(userId, agentId, gameCode);

    this.logger.debug(
      `Cashout flow initiated: user=${userId} agent=${agentId} key=${redisKey}`,
    );

    const gameSession: GameSession = await this.redisService.get<any>(redisKey);

    if (!gameSession || !gameSession.isActive) {
      this.logger.warn(
        `No active session for cashout: user=${userId} agent=${agentId}`,
      );
      return { error: ERROR_MESSAGES.NO_ACTIVE_SESSION };
    }

    gameSession.isActive = false;
    gameSession.isWin = true;

    const currentMultiplier =
      gameSession.currentStep >= 0
        ? Number(gameSession.coefficients[gameSession.currentStep])
        : 0;

    const sessionTTL = await this.redisService.getSessionTTL(gameCode);
    await this.redisService.set(redisKey, gameSession, sessionTTL);

    const settlementAmount = gameSession.winAmount;

    this.logger.log(
      `[CASHOUT] user=${userId} agent=${agentId} step=${gameSession.currentStep} multiplier=${currentMultiplier} winAmount=${settlementAmount} txId=${gameSession.platformBetTxId}`,
    );

    try {
      // WalletService automatically gets gamePayloads via WalletApiAdapter (GameService)
      const settleResult = await this.walletService.settleBet({
        agentId: gameSession.agentId,
        platformTxId: gameSession.platformBetTxId,
        userId,
        winAmount: settlementAmount,
        roundId: gameSession.roundId,
        betAmount: parseFloat(gameSession.betAmount.toString()),
        gameCode,
        gameSession,
      });

      this.logger.log(
        `Cashout settlement success: user=${userId} balance=${settleResult.balance} status=${settleResult.status} settlementAmount=${settlementAmount} txId=${gameSession.platformBetTxId}`,
      );

      const betAmountNum = parseFloat(gameSession.betAmount.toString());
      const winAmountNum = settlementAmount;
      const withdrawCoeff = betAmountNum > 0 && winAmountNum > 0
        ? (winAmountNum / betAmountNum).toFixed(3)
        : '0';
      const finalCoeff = gameSession.currentStep >= 0
        ? gameSession.coefficients[gameSession.currentStep]
        : '0';
      
      // Generate fairness data using seeds from game session
      const fairnessData = this.generateFairnessData(
        gameSession.userSeed,
        gameSession.serverSeed,
        gameSession.roundId,
      );

      this.logger.debug(
        `Updating bet record with cashout settlement: user=${userId} txId=${gameSession.platformBetTxId} winAmount=${settlementAmount.toFixed(GAME_CONSTANTS.DECIMAL_PLACES)}`,
      );
      await this.betService.recordSettlement({
        externalPlatformTxId: gameSession.platformBetTxId,
        winAmount: settlementAmount.toFixed(GAME_CONSTANTS.DECIMAL_PLACES),
        settledAt: new Date(),
        balanceAfterSettlement: settleResult.balance
          ? String(settleResult.balance)
          : undefined,
        updatedBy: userId,
        finalCoeff,
        withdrawCoeff,
        fairnessData,
      });

      // Rotate seeds after successful cashout settlement
      try {
        await this.fairnessService.rotateSeeds(userId, agentId);
      } catch (rotateError) {
        this.logger.warn(
          `Failed to rotate seeds after cashout: user=${userId} agent=${agentId} error=${rotateError.message}`,
        );
        // Don't fail cashout if seed rotation fails
      }

      // Delete session from Redis after successful cashout settlement (bet is now WON)
      try {
        await this.redisService.del(redisKey);
        this.logger.debug(
          `Deleted game session from Redis after cashout: user=${userId} txId=${gameSession.platformBetTxId}`,
        );
      } catch (deleteError) {
        this.logger.warn(
          `Failed to delete session after cashout: user=${userId} txId=${gameSession.platformBetTxId} error=${deleteError.message}`,
        );
        // Don't fail cashout if session deletion fails
      }
    } catch (error: any) {
      this.logger.error(
        `Cashout settlement failed: user=${userId} txId=${gameSession.platformBetTxId}`,
        error,
      );

      // Error already logged in singleWalletFunctionsService.settleBet() with full details
      // (requestId, responseTime, httpStatus, etc.) and retry job already created
      // No need to log again here to avoid duplicate entries

      throw new Error(ERROR_MESSAGES.SETTLEMENT_FAILED);
    }

    let hazardColumns = await this.hazardSchedulerService.getActiveHazards(
        gameCode,
        gameSession.difficulty,
      );

    return this.sendStepResponse(
      gameSession.isActive,
      gameSession.isWin,
      gameSession.currentStep,
      gameSession.winAmount,
      gameSession.betAmount,
      currentMultiplier,
      gameSession.difficulty,
      gameSession.currency,
      'cashout',
      hazardColumns
    );
  }

  async performGetSessionFlow(
    userId: string,
    agentId: string,
    gameCode: string,
  ): Promise<BetStepResponse | { error: string }> {
    const redisKey = this.getRedisKey(userId, agentId, gameCode);
    const gameSession: GameSession = await this.redisService.get<any>(redisKey);

    if (!gameSession) {
      return { error: 'no_session' };
    }

    const currentMultiplier = this.getStepCoeff(
      gameSession,
      gameSession.currentStep,
    );

    let endReason: 'win' | 'cashout' | 'hazard' | undefined;
    if (!gameSession.isActive) {
      if (gameSession.isWin) {
        endReason = 'win';
      } else if (gameSession.collisionColumns) {
        endReason = 'hazard';
      } else {
        endReason = 'cashout';
      }
    }

    return this.sendStepResponse(
      gameSession.isActive,
      gameSession.isWin,
      gameSession.currentStep,
      gameSession.winAmount,
      gameSession.betAmount,
      currentMultiplier,
      gameSession.difficulty,
      gameSession.currency,
      endReason,
      gameSession.collisionColumns,
    );
  }

  async performGetGameStateFlow(
    userId: string,
    agentId: string,
    gameCode: string,
  ): Promise<BetStepResponse | null> {
    const redisKey = this.getRedisKey(userId, agentId, gameCode);
    const gameSession: GameSession = await this.redisService.get<any>(redisKey);

    if (!gameSession) {
      return null;
    }

    const currentMultiplier = this.getStepCoeff(
      gameSession,
      gameSession.currentStep,
    );

    if(!gameSession.isActive){
      return null;
    }

    let endReason: 'win' | 'cashout' | 'hazard' | undefined;
    if (!gameSession.isActive) {
      if (gameSession.isWin) {
        endReason = 'win';
      } else if (gameSession.collisionColumns) {
        endReason = 'hazard';
      } else {
        endReason = 'cashout';
      }
    }

    return this.sendStepResponse(
      gameSession.isActive,
      gameSession.isWin,
      gameSession.currentStep,
      gameSession.winAmount,
      gameSession.betAmount,
      currentMultiplier,
      gameSession.difficulty,
      gameSession.currency,
      endReason,
      gameSession.collisionColumns,
    );
  }

  private getStepCoeff(session: GameSession, stepIndex: number): number {
    if (stepIndex < 0) return DEFAULTS.GAME.DEFAULT_MULTIPLIER;
    const arr: string[] = session.coefficients || [];
    const raw = arr[stepIndex];
    const val = parseFloat(raw);
    return isFinite(val) ? val : DEFAULTS.GAME.DEFAULT_MULTIPLIER;
  }

  private sendStepResponse(
    isActive: boolean,
    isWin: boolean,
    currentStep: number,
    winAmount: number,
    betAmount: number,
    multiplier: number,
    difficulty: Difficulty,
    currency: string,
    endReason?: 'win' | 'cashout' | 'hazard',
    collisionColumns?: number[],
  ): BetStepResponse {
    const response: BetStepResponse = {
      isFinished: !isActive,
      lineNumber: currentStep,
      winAmount: winAmount.toFixed(GAME_CONSTANTS.DECIMAL_PLACES),
      betAmount: betAmount.toFixed(GAME_CONSTANTS.DECIMAL_PLACES),
      coeff: multiplier.toFixed(GAME_CONSTANTS.DECIMAL_PLACES),
      difficulty: String(difficulty),
      currency,
    };

    // For win or cashout: include isWin: true and collisionPositions with final position
    if (endReason && (endReason === 'win' || endReason === 'cashout')) {
      response.isWin = true;
      response.collisionPositions = collisionColumns;
    }
    // For hazard: do NOT include isWin, but include collisionPositions
    else if (endReason && endReason === 'hazard') {
      response.collisionPositions = collisionColumns;
    }
    // For simple step (no endReason): include isWin: false
    else {
      if (collisionColumns) {
        response.collisionPositions = collisionColumns;
      }
    }

    return response;
  }

  buildPlaceholder(action: string, payload: any) {
    switch (action) {
      case 'withdraw':
      case 'cashout':
        return {
          action,
          status: 'not_implemented',
          message: `${action} logic not implemented yet`,
        };
      case 'get-game-session':
        return {
          action,
          status: 'not_implemented',
          message: 'Game session retrieval not implemented yet',
          session: null,
          hint: 'Will return current active session details when implemented',
        };
      case 'get-game-seeds':
      case 'set-user-seed':
        // These are now implemented, but handled separately
        return {
          action,
          status: 'not_implemented',
          message: 'This action should be handled by dedicated handler',
        };
      default:
        return {
          action,
          status: 'not_implemented',
          received: payload ?? null,
        };
    }
  }

  private async safeGetConfig(gameCode: string, key: string): Promise<string> {
    try {
      //TODO: Add support for multiple games
      const raw = await this.gameConfigService.getConfig(gameCode, key);
      return typeof raw === 'string' ? raw : JSON.stringify(raw);
    } catch (e) {
      this.logger.warn(`Config key ${key} not available: ${e}`);
      return '{}';
    }
  }

  private tryParseJson(value: string): any {
    try {
      return JSON.parse(value);
    } catch {
      return undefined;
    }
  }

  async getCurrencies(): Promise<any> {
    return {
      "ADA": 2.493846558309699,
      "AED": 3.6725,
      "AFN": 70,
      "ALL": 85.295,
      "AMD": 383.82,
      "ANG": 1.8022999999999998,
      "AOA": 918.65,
      "ARS": 1371.4821,
      "AUD": 1.5559,
      "AWG": 1.79,
      "AZN": 1.7,
      "BAM": 1.7004695059,
      "BBD": 2.0181999999999998,
      "BCH": 0.0020396093727826324,
      "BDT": 122.24999999999999,
      "BGN": 1.712,
      "BHD": 0.377,
      "BIF": 2981,
      "BMD": 1,
      "BNB": 0.0012299246747673688,
      "BND": 1.2974999999999999,
      "BOB": 6.907100000000001,
      "BRL": 5.6015,
      "BSD": 0.9997,
      "BTC": 0.000012050399374548936,
      "BTN": 89.6467799909,
      "BUSD": 0.9996936638705801,
      "BWP": 13.6553,
      "BYN": 3.2712,
      "BZD": 2.0078,
      "CAD": 1.3858,
      "CDF": 2277.4996633416,
      "CHF": 0.8140000000000001,
      "CLF": 0.0238335343,
      "CLP": 972.65,
      "COP": 4186.71,
      "CRC": 505.29,
      "CSC": 33830.23149660104,
      "CUP": 23.990199999999998,
      "CVE": 95.8727355712,
      "CZK": 21.5136,
      "DASH": 0.015423150141854353,
      "DJF": 178.08,
      "DKK": 6.5351,
      "DLS": 33.333333333333336,
      "DOGE": 7.249083135964963,
      "DOP": 61,
      "DZD": 130.923,
      "EGP": 48.57,
      "EOS": 1.2787330681036353,
      "ERN": 15,
      "ETB": 138.20000000000002,
      "ETC": 0.07559846492841533,
      "ETH": 0.00036986204295658424,
      "EUR": 0.8755000000000001,
      "FJD": 2.2723999999999998,
      "FKP": 0.7642057337999999,
      "GBP": 0.7571,
      "GC": 1,
      "GEL": 2.7035,
      "GHS": 10.5,
      "GIP": 0.7642057337999999,
      "GMD": 72.815,
      "GMS": 1,
      "GNF": 8674.5,
      "GTQ": 7.675,
      "GYD": 209.143149197,
      "HKD": 7.849799999999999,
      "HNL": 26.2787,
      "HRK": 6.550767445000001,
      "HTG": 131.16899999999998,
      "HUF": 350.19,
      "IDR": 16443.4,
      "ILS": 3.3960999999999997,
      "INR": 87.503,
      "IQD": 1310,
      "IRR": 42112.5,
      "ISK": 124.46999999999998,
      "JMD": 159.94400000000002,
      "JOD": 0.709,
      "JPY": 150.81,
      "KES": 129.2,
      "KGS": 87.45,
      "KHR": 4015,
      "KMF": 431.5,
      "KPW": 899.9849041373,
      "KRW": 1392.51,
      "KWD": 0.30610000000000004,
      "KYD": 0.8315739408,
      "KZT": 540.8199999999999,
      "LAK": 21580,
      "LBP": 89550,
      "LKR": 302.25,
      "LRD": 181.4831374426,
      "LSL": 18.2179,
      "LTC": 0.01219800670691517,
      "LYD": 5.415,
      "MAD": 9.154300000000001,
      "MDL": 17.08,
      "MGA": 4430,
      "MKD": 52.885000000000005,
      "MMK": 3247.961,
      "MNT": 3590,
      "MOP": 8.089,
      "MRU": 39.626114384800005,
      "MUR": 46.65,
      "MVR": 15.459999999999999,
      "MWK": 1733.67,
      "MXN": 18.869,
      "MYR": 4.265,
      "MZN": 63.910000000000004,
      "NAD": 18.2179,
      "NGN": 1532.39,
      "NIO": 36.75,
      "NOK": 10.3276,
      "NPR": 140.07,
      "NZD": 1.6986,
      "OMR": 0.385,
      "PAB": 1.0009,
      "PEN": 3.569,
      "PGK": 4.1303,
      "PHP": 58.27,
      "PKR": 283.25,
      "PLN": 3.7442,
      "PYG": 7486.400000000001,
      "QAR": 3.6408,
      "R$": 476.1904761904762,
      "RON": 4.440300000000001,
      "RSD": 102.56500000000001,
      "RUB": 79.87530000000001,
      "RWF": 1440,
      "SAR": 3.7513,
      "SBD": 8.2464031996,
      "SC": 1,
      "SCR": 14.1448,
      "SDG": 600.5,
      "SEK": 9.7896,
      "SGD": 1.2979,
      "SHIB": 128205.1282051282,
      "SHP": 0.7642057337999999,
      "SLE": 22.830015851400002,
      "SOL": 0.007978209381592608,
      "SOS": 571.5,
      "SRD": 38.553892635900006,
      "SSP": 130.26,
      "SVC": 8.7464,
      "SYP": 13005,
      "SZL": 18.01,
      "THB": 32.752,
      "TND": 2.88,
      "TON": 0.6662012207757025,
      "TRX": 3.6218917423077635,
      "TRY": 40.6684,
      "TWD": 29.918000000000003,
      "TZS": 2570,
      "UAH": 41.6966,
      "uBTC": 12.050399374548936,
      "UGX": 3583.3,
      "USD": 1,
      "USDC": 0.999303605303536,
      "USDT": 1,
      "UYU": 40.0886,
      "UZS": 12605,
      "VEF": 23922474.033511065,
      "VES": 123.7216,
      "VND": 26199,
      "XAF": 573.151,
      "XLM": 4.4032459143712215,
      "XMR": 0.008457936691358008,
      "XOF": 566.5,
      "XRP": 0.5234373962121788,
      "ZAR": 18.2178,
      "ZEC": 0.0016208628014450959,
      "ZMW": 23.1485244936,
      "ZWL": 26.852999999999998
    };
  }

  async getGameConfigPayload(gameCode: string): Promise<GameConfigPayload> {
    try {
      const betConfigRaw = await this.safeGetConfig(gameCode, 'betConfig');
      const coeffRaw = await this.safeGetConfig(gameCode, 'coefficients');
      const betConfig = this.tryParseJson(betConfigRaw) || {};
      const coefficients = this.tryParseJson(coeffRaw) || {};
      let newBetConfig = betConfig;
      try {
        const { currency, decimalPlaces, ...rest } = betConfig;
        newBetConfig = rest;
      } catch (e) {
        this.logger.error(`Failed to parse bet config: ${e}`);
      }

      return {
        betConfig: newBetConfig,
        coefficients,
        lastWin: {
          username: DEFAULTS.LAST_WIN.DEFAULT_USERNAME,
          winAmount: DEFAULTS.LAST_WIN.DEFAULT_WIN_AMOUNT,
          currency: DEFAULTS.LAST_WIN.DEFAULT_CURRENCY,
        }
      }
    } catch (e) {
      this.logger.error(`Failed building game config payload: ${e}`);
      return {
        betConfig: {},
        coefficients: {},
        lastWin: {
          username: DEFAULTS.LAST_WIN.FALLBACK_USERNAME,
          winAmount: DEFAULTS.LAST_WIN.FALLBACK_WIN_AMOUNT,
          currency: DEFAULTS.LAST_WIN.FALLBACK_CURRENCY,
        },
      }
    }
  }

  /**
   * Get game seeds for a user
   * Returns userSeed, hashedServerSeed, and nonce
   */
  async getGameSeeds(
    userId: string,
    agentId: string,
  ): Promise<{
    userSeed: string;
    hashedServerSeed: string;
    nonce: string;
  }> {
    const fairnessData = await this.fairnessService.getOrCreateFairness(
      userId,
      agentId,
    );

    return {
      userSeed: fairnessData.userSeed,
      hashedServerSeed: fairnessData.hashedServerSeed,
      nonce: fairnessData.nonce.toString(),
    };
  }

  /**
   * Set user seed
   */
  async setUserSeed(
    userId: string,
    agentId: string,
    userSeed: string,
  ): Promise<{ success: boolean; userSeed: string }> {
    const fairnessData = await this.fairnessService.setUserSeed(
      userId,
      agentId,
      userSeed,
    );

    return {
      success: true,
      userSeed: fairnessData.userSeed,
    };
  }

  /**
   * Generate fairness data for bet history
   * Uses seeds from game session if available, otherwise falls back to legacy method
   */
  private generateFairnessData(
    userSeed?: string,
    serverSeed?: string,
    roundId?: string,
  ): {
    decimal: string;
    clientSeed: string;
    serverSeed: string;
    combinedHash: string;
    hashedServerSeed: string;
  } {
    // If seeds are provided, use fairness service
    if (userSeed && serverSeed) {
      return this.fairnessService.generateFairnessDataForBet(
        userSeed,
        serverSeed,
      );
    }

    // Legacy fallback (for backward compatibility)
    const crypto = require('crypto');
    const clientSeed = roundId?.substring(0, DEFAULTS.FAIRNESS.CLIENT_SEED_LENGTH) || DEFAULTS.FAIRNESS.LEGACY_CLIENT_SEED;
    const finalServerSeed = serverSeed || crypto.randomBytes(32).toString('hex');
    const combined = `${clientSeed}${finalServerSeed}`;
    const combinedHash = crypto.createHash('sha256').update(combined).digest('hex');
    const hashedServerSeed = crypto.createHash('sha256').update(finalServerSeed).digest('hex');
    
    // Generate decimal from hash (first 20 chars as hex, convert to decimal)
    const hashPrefix = combinedHash.substring(0, 20);
    const decimalValue = BigInt('0x' + hashPrefix).toString();
    const decimal = parseFloat(decimalValue) > 1e100 
      ? parseFloat(decimalValue).toExponential() 
      : decimalValue;

    return {
      decimal: decimal.toString(),
      clientSeed,
      serverSeed: finalServerSeed,
      combinedHash,
      hashedServerSeed,
    };
  }

  /**
   * Get bet history for a user
   * Returns first 30 bets ordered by creation date (newest first)
   */
  async getMyBetsHistory(
    userId: string,
    agentId: string,
    gameCode?: string,
  ): Promise<any[]> {
    this.logger.debug(
      `Fetching bet history: user=${userId} agent=${agentId}`,
    );

    const lastWeek = new Date(Date.now() - DEFAULTS.GAME.BET_HISTORY_DAYS * 24 * 60 * 60 * 1000);  

    const bets = await this.betService.listUserBetsByTimeRange(userId, lastWeek, new Date(), gameCode, DEFAULTS.GAME.BET_HISTORY_LIMIT);

    return bets.map((bet) => {
      const betAmount = parseFloat(bet.betAmount || '0');
      const winAmount = parseFloat(bet.winAmount || '0');
      
      const withdrawCoeff = bet.withdrawCoeff 
        ? parseFloat(bet.withdrawCoeff) 
        : (betAmount > 0 && winAmount > 0 ? winAmount / betAmount : 0);
      
      const gameMetaCoeff = bet.finalCoeff 
        ? bet.finalCoeff 
        : (betAmount > 0 && winAmount > 0 ? (winAmount / betAmount).toFixed(2) : '0');

      // Use stored fairness data if available, otherwise generate fallback
      const fairness = bet.fairnessData || this.generateFairnessData(
        undefined,
        undefined,
        bet.roundId,
      );

      return {
        id: bet.id,
        createdAt: bet.createdAt.toISOString(),
        gameId: 0,
        finishCoeff: 0,
        fairness,
        betAmount: betAmount,
        win: winAmount,
        withdrawCoeff: withdrawCoeff,
        operatorId: bet.operatorId || agentId,
        userId: bet.userId,
        currency: bet.currency,
        gameMeta: {
          coeff: gameMetaCoeff,
          difficulty: bet.gameMetadata?.difficulty as Difficulty,
        },
      };
    });
  }

  private getRedisKey(userId: string, agentId: string, gameCode: string): string {
    return `gameSession:${userId}-${agentId}-${gameCode}`;
  }

  async cleanupOnDisconnect(): Promise<void> {
    try {
      this.logger.warn('[cleanupOnDisconnect] Clearing all Redis data...');
      await this.redisService.flushAll();

      this.logger.warn('[cleanupOnDisconnect] Deleting all PLACED bets...');
      // const deletedCount = await this.betService.deletePlacedBets();

      // this.logger.warn(
      //   `[cleanupOnDisconnect] Cleanup complete - Redis flushed, ${deletedCount} PLACED bets deleted`,
      // );
    } catch (error) {
      this.logger.error(
        `[cleanupOnDisconnect] Cleanup failed: ${error.message}`,
        error.stack,
      );
    }
  }
}
