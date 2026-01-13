import { HttpService } from '@nestjs/axios';
import {
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { firstValueFrom } from 'rxjs';
import { v4 as uuidv4 } from 'uuid';
import { AgentsService, BetService, WalletAuditService, WalletAuditStatus, WalletApiAction, WalletErrorType } from '@vector-games/game-core';
import { GameConfigService } from '../../modules/gameConfig/game-config.service';
import { WalletRetryJobService } from '../../modules/wallet-retry/wallet-retry-job.service';
import { DEFAULTS } from '../../config/defaults.config';

@Injectable()
export class SingleWalletFunctionsService {

  private readonly logger = new Logger(SingleWalletFunctionsService.name);

  constructor(
    private readonly agentsService: AgentsService,
    private readonly http: HttpService,
    private readonly walletAuditService: WalletAuditService,
    private readonly retryJobService: WalletRetryJobService,
    private readonly betService: BetService,
  ) { }

  private async resolveAgent(agentId: string) {
    const agent = await this.agentsService.findOne(agentId);
    if (!agent) {
      throw new NotFoundException(`Agent '${agentId}' not found`);
    }
    return {
      callbackURL: agent.callbackURL,
      cert: agent.cert,
      agentId: agent.agentId,
    };
  }

  // Unified agent response interface
  private mapAgentResponse(data: any) {
    if (!data || typeof data.status !== 'string') {
      throw new InternalServerErrorException('Malformed agent response');
    }
    return {
      balance: Number(data.balance ?? 0),
      balanceTs: data.balanceTs ?? null,
      status: data.status,
      userId: data.userId ?? null,
      raw: data,
    } as const;
  }

  /**
   * Log audit record (non-blocking, fire-and-forget)
   * Errors are caught and logged but don't throw to avoid breaking API calls
   */
  private logAudit(params: {
    requestId: string;
    agentId: string;
    userId: string;
    apiAction: WalletApiAction;
    status: WalletAuditStatus;
    requestPayload?: any;
    requestUrl?: string;
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
  }): void {
    // Wrap in try-catch to handle any synchronous errors
    try {
      const auditPromise = this.walletAuditService.logAudit(params);
      if (auditPromise && typeof auditPromise.catch === 'function') {
        auditPromise.catch((err: any) => {
          // Double-wrap to ensure we never throw
          try {
            this.logger.error(
              `Failed to log wallet audit (non-blocking): ${err?.message || 'Unknown error'}`,
              err?.stack,
            );
          } catch (logError) {
            // If even logging fails, silently fail - never crash the app
            console.error('Critical: Failed to log audit error', logError);
          }
        });
      }
    } catch (syncError: any) {
      // Handle any synchronous errors (e.g., if walletAuditService is undefined)
      try {
        this.logger.error(
          `Failed to initiate wallet audit logging (sync error): ${syncError?.message || 'Unknown error'}`,
          syncError?.stack,
        );
      } catch {
        // If even logging fails, silently fail
        console.error('Critical: Failed to log sync audit error', syncError);
      }
    }
  }

  /**
   * Safely create retry job - never throws, never crashes the app
   */
  private createRetryJobSafely(params: {
    platformTxId: string;
    apiAction: WalletApiAction;
    agentId: string;
    userId: string;
    requestPayload: any;
    callbackUrl: string;
    roundId?: string;
    betAmount?: number | string;
    winAmount?: number | string;
    currency?: string;
    gamePayloads?: any;
    walletAuditId?: string;
    errorMessage?: string;
  }): void {
    try {
      const retryPromise = this.retryJobService.createRetryJob(params);
      if (retryPromise && typeof retryPromise.catch === 'function') {
        retryPromise.catch((err: any) => {
          try {
            this.logger.error(
              `Failed to create retry job (non-blocking): ${err?.message || 'Unknown error'}`,
              err?.stack,
            );
          } catch (logError) {
            console.error('Critical: Failed to log retry job error', logError);
          }
        });
      }
    } catch (syncError: any) {
      try {
        this.logger.error(
          `Failed to initiate retry job creation (sync error): ${syncError?.message || 'Unknown error'}`,
          syncError?.stack,
        );
      } catch {
        console.error('Critical: Failed to log sync retry job error', syncError);
      }
    }
  }

  async getBalance(
    agentId: string,
    userId: string,
  ): Promise<{
    balance: number;
    balanceTs: string | null;
    status: string;
    userId: string | null;
    raw: any;
  }> {
    const requestId = uuidv4();
    const { callbackURL, cert } = await this.resolveAgent(agentId);
    const url = callbackURL;
    const messageObj = { action: 'getBalance', userId };
    const payload = { key: cert, message: JSON.stringify(messageObj) };
    const requestStartTime = Date.now();
    this.logger.debug(`Calling getBalance url=${url} agent=${agentId} requestId=${requestId}`);
    try {
      const resp = await firstValueFrom(this.http.post<any>(url, payload));
      const responseTime = Date.now() - requestStartTime;
      const mappedResponse = this.mapAgentResponse(resp.data);
      
      // Check if agent rejected the request (status !== '0000' means failure)
      if (mappedResponse.status !== '0000') {
        const errorMessage = `Agent rejected getBalance with status: ${mappedResponse.status}`;
        
        // Log to audit (non-blocking)
        this.logAudit({
          requestId,
          agentId,
          userId,
          apiAction: WalletApiAction.GET_BALANCE,
          status: WalletAuditStatus.FAILURE,
          requestPayload: { messageObj, url },
          requestUrl: url,
          responseData: mappedResponse.raw,
          httpStatus: resp.status,
          responseTime,
          failureType: WalletErrorType.AGENT_REJECTED,
          errorMessage,
          callbackUrl: url,
        });

        throw new InternalServerErrorException(errorMessage);
      }
      
      // Log success to audit (non-blocking)
      this.logAudit({
        requestId,
        agentId,
        userId,
        apiAction: WalletApiAction.GET_BALANCE,
        status: WalletAuditStatus.SUCCESS,
        requestPayload: { messageObj, url },
        requestUrl: url,
        responseData: mappedResponse.raw,
        httpStatus: resp.status,
        responseTime,
        callbackUrl: url,
      });
      
      return mappedResponse;
    } catch (err: any) {
      const responseTime = Date.now() - requestStartTime;
      this.logger.error(
        `getBalance failed agent=${agentId} user=${userId} requestId=${requestId}`,
        err,
      );

      // Determine error type
      let errorType = WalletErrorType.UNKNOWN_ERROR;
      let httpStatus: number | undefined;
      let responseData: any = null;

      if (err.response) {
        httpStatus = err.response.status;
        responseData = err.response.data;
        errorType = WalletErrorType.HTTP_ERROR;
      } else if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
        errorType = WalletErrorType.NETWORK_ERROR;
      } else if (err.code === 'ETIMEDOUT' || err.name === 'TimeoutError') {
        errorType = WalletErrorType.TIMEOUT_ERROR;
      }

      // Log to audit (non-blocking)
      this.logAudit({
        requestId,
        agentId,
        userId,
        apiAction: WalletApiAction.GET_BALANCE,
        status: WalletAuditStatus.FAILURE,
        requestPayload: { messageObj, url },
        requestUrl: url,
        responseData,
        httpStatus,
        responseTime,
        failureType: errorType,
        errorMessage: err.message || 'Unknown error',
        errorStack: err.stack,
        callbackUrl: url,
        rawError: JSON.stringify(err),
      });

      throw err;
    }
  }

  async placeBet(
    agentId: string,
    userId: string,
    amount: number,
    roundId: string,
    platformTxId: string,
    currency: string = DEFAULTS.CURRENCY.DEFAULT,
    gamePayloads: any
  ): Promise<{
    balance: number;
    balanceTs: string | null;
    status: string;
    userId: string | null;
    raw: any;
  }> {
    const requestId = uuidv4();
    const { callbackURL, cert } = await this.resolveAgent(agentId);
    const url = callbackURL;
    const betTime = new Date().toISOString();

    const txn = {
      platformTxId,
      userId,
      currency,
      ...gamePayloads,
      betType: null,
      betAmount: amount,
      betTime,
      roundId,
      isPremium: false,
    };

    const messageObj = { action: 'bet', txns: [txn] };
    const payload = { key: cert, message: JSON.stringify(messageObj) };
    const requestStartTime = Date.now();
    this.logger.debug(
      `[WALLET_API_REQUEST] user=${userId} agent=${agentId} action=placeBet url=${url} amount=${amount} roundId=${roundId} txId=${platformTxId} requestId=${requestId}`,
    );
    try {
      
      const resp = await firstValueFrom(this.http.post<any>(url, payload));
      const responseTime = Date.now() - requestStartTime;
      const mappedResponse = this.mapAgentResponse(resp.data);
      this.logger.log(
        `[WALLET_API_RESPONSE] user=${userId} agent=${agentId} action=placeBet status=${mappedResponse.status} balance=${mappedResponse.balance} responseTime=${responseTime}ms`,
      );
      
      // Check if agent rejected the bet (status !== '0000' means failure)
      if (mappedResponse.status !== '0000') {
        const errorMessage = `Agent rejected bet with status: ${mappedResponse.status}`;
        
        // Log to audit (non-blocking)
        this.logAudit({
          requestId,
          agentId,
          userId,
          apiAction: WalletApiAction.PLACE_BET,
          status: WalletAuditStatus.FAILURE,
          requestPayload: { messageObj, url },
          requestUrl: url,
          responseData: mappedResponse.raw,
          httpStatus: resp.status,
          responseTime,
          failureType: WalletErrorType.AGENT_REJECTED,
          errorMessage,
          platformTxId,
          roundId,
          betAmount: amount,
          currency,
          callbackUrl: url,
        });

        throw new InternalServerErrorException(errorMessage);
      }
      
      // Log success to audit (non-blocking)
      this.logAudit({
        requestId,
        agentId,
        userId,
        apiAction: WalletApiAction.PLACE_BET,
        status: WalletAuditStatus.SUCCESS,
        requestPayload: { messageObj, url },
        requestUrl: url,
        responseData: mappedResponse.raw,
        httpStatus: resp.status,
        responseTime,
        platformTxId,
        roundId,
        betAmount: amount,
        currency,
        callbackUrl: url,
      });
      
      return mappedResponse;
    } catch (err: any) {
      const responseTime = Date.now() - requestStartTime;
      this.logger.error(
        `placeBet failed agent=${agentId} user=${userId} requestId=${requestId}`,
        err,
      );

      // Determine error type
      let errorType = WalletErrorType.UNKNOWN_ERROR;
      let httpStatus: number | undefined;
      let responseData: any = null;

      if (err.response) {
        httpStatus = err.response.status;
        responseData = err.response.data;
        errorType = WalletErrorType.HTTP_ERROR;
      } else if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
        errorType = WalletErrorType.NETWORK_ERROR;
      } else if (err.code === 'ETIMEDOUT' || err.name === 'TimeoutError') {
        errorType = WalletErrorType.TIMEOUT_ERROR;
      }

      // Log to audit (non-blocking)
      this.logAudit({
        requestId,
        agentId,
        userId,
        apiAction: WalletApiAction.PLACE_BET,
        status: WalletAuditStatus.FAILURE,
        requestPayload: { messageObj, url },
        requestUrl: url,
        responseData,
        httpStatus,
        responseTime,
        failureType: errorType,
        errorMessage: err.message || 'Unknown error',
        errorStack: err.stack,
        platformTxId,
        roundId,
        betAmount: amount,
        currency,
        callbackUrl: url,
        rawError: JSON.stringify(err),
      });

      throw err;
    }
  }


  async settleBet(
    agentId: string,
    platformTxId: string,
    userId: string,
    winAmount: number,
    roundId: string,
    betAmount: number,
    gamePayloads: any,
    gameSession?: any
  ): Promise<{
    balance: number;
    balanceTs: string | null;
    status: string;
    userId: string | null;
    raw: any;
  }> {
    const requestId = uuidv4();
    const { callbackURL, cert } = await this.resolveAgent(agentId);
    const url = callbackURL;
    const txTime = new Date().toISOString();
    const txn = {
      platformTxId,
      userId,
      ...gamePayloads,
      refPlatformTxId: null,
      settleType: gamePayloads.settleType,
      gameType: gamePayloads.gameType,
      gameCode: gamePayloads.gameCode,
      gameName: gamePayloads.gameName,
      betType: null,
      betAmount: Number(betAmount),
      winAmount: Number(winAmount),
      betTime: txTime,
      roundId,
    };
    if(gameSession) {
      txn.gameInfo = JSON.stringify(gameSession);
    }
    const messageObj = { action: 'settle', txns: [txn] };
    const payload = { key: cert, message: JSON.stringify(messageObj) };
    const requestStartTime = Date.now();
    this.logger.debug(
      `[WALLET_API_REQUEST] user=${userId} agent=${agentId} action=settleBet url=${url} txId=${platformTxId} betAmount=${betAmount} winAmount=${winAmount} roundId=${roundId} requestId=${requestId}`,
    );
    try {
      const resp = await firstValueFrom(this.http.post<any>(url, payload));
      const responseTime = Date.now() - requestStartTime;
      const mappedResponse = this.mapAgentResponse(resp.data);
      this.logger.log(
        `[WALLET_API_RESPONSE] user=${userId} agent=${agentId} action=settleBet status=${mappedResponse.status} balance=${mappedResponse.balance} responseTime=${responseTime}ms`,
      );
      
      // Check if agent rejected the settlement (status !== '0000' means failure)
      if (mappedResponse.status !== '0000') {
        const errorMessage = `Agent rejected settlement with status: ${mappedResponse.status}`;
        const currency = gamePayloads.currency || DEFAULTS.CURRENCY.DEFAULT;
        
        // Log to audit first (non-blocking)
        this.walletAuditService.logAudit({
          requestId,
          agentId,
          userId,
          apiAction: WalletApiAction.SETTLE_BET,
          status: WalletAuditStatus.FAILURE,
          requestPayload: { messageObj, url },
          requestUrl: url,
          responseData: mappedResponse.raw,
          httpStatus: resp.status,
          responseTime,
          failureType: WalletErrorType.AGENT_REJECTED,
          errorMessage,
          platformTxId,
          roundId,
          betAmount,
          winAmount,
          currency,
          callbackUrl: url,
        }).then(async (auditRecord) => {
          // Create retry job (non-blocking)
          this.createRetryJobSafely({
            platformTxId,
            apiAction: WalletApiAction.SETTLE_BET,
            agentId,
            userId,
            requestPayload: { messageObj, url, payload },
            callbackUrl: url,
            roundId,
            betAmount,
            winAmount,
            currency,
            gamePayloads,
            walletAuditId: auditRecord?.id,
            errorMessage,
          });
        }).catch((auditError) => {
          this.logger.error(
            `Failed to log audit for settleBet: ${auditError?.message || 'Unknown error'}`,
          );
        });

        // Mark bet as settlement failed when agent rejects
        try {
          await this.betService.markSettlementFailed(platformTxId, userId);
          this.logger.warn(
            `Marked bet as settlement_failed (agent rejected): txId=${platformTxId} user=${userId} status=${mappedResponse.status}`,
          );
        } catch (betUpdateError) {
          this.logger.error(
            `Failed to mark bet as settlement_failed: txId=${platformTxId} error=${betUpdateError}`,
          );
        }

        throw new InternalServerErrorException(errorMessage);
      }
      
      // Log success to audit (non-blocking)
      this.logAudit({
        requestId,
        agentId,
        userId,
        apiAction: WalletApiAction.SETTLE_BET,
        status: WalletAuditStatus.SUCCESS,
        requestPayload: { messageObj, url },
        requestUrl: url,
        responseData: mappedResponse.raw,
        httpStatus: resp.status,
        responseTime,
        platformTxId,
        roundId,
        betAmount,
        winAmount,
        currency: gamePayloads.currency || DEFAULTS.CURRENCY.DEFAULT,
        callbackUrl: url,
      });
      
      return mappedResponse;
    } catch (err: any) {
      const responseTime = Date.now() - requestStartTime;
      const currency = gamePayloads.currency || DEFAULTS.CURRENCY.DEFAULT;
      
      // Determine error type
      let errorType = WalletErrorType.UNKNOWN_ERROR;
      let httpStatus: number | undefined;
      let responseData: any = null;

      if (err.response) {
        httpStatus = err.response.status;
        responseData = err.response.data;
        errorType = WalletErrorType.HTTP_ERROR;
      } else if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
        errorType = WalletErrorType.NETWORK_ERROR;
      } else if (err.code === 'ETIMEDOUT' || err.name === 'TimeoutError') {
        errorType = WalletErrorType.TIMEOUT_ERROR;
      }

      const errorTypeStr = err.response?.status >= 400 && err.response?.status < 500 
        ? 'CLIENT_ERROR' 
        : err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND'
        ? 'NETWORK_ERROR'
        : err.code === 'ETIMEDOUT' || err.name === 'TimeoutError'
        ? 'TIMEOUT_ERROR'
        : 'UNKNOWN_ERROR';
      this.logger.error(
        `[WALLET_API_ERROR] user=${userId} agent=${agentId} action=settleBet txId=${platformTxId} errorType=${errorTypeStr} httpStatus=${httpStatus || 'N/A'} responseTime=${responseTime}ms error=${err.message} requestId=${requestId}`,
        err.stack,
      );

      // Log to audit first (non-blocking), then create retry job
      this.walletAuditService.logAudit({
        requestId,
        agentId,
        userId,
        apiAction: WalletApiAction.SETTLE_BET,
        status: WalletAuditStatus.FAILURE,
        requestPayload: { messageObj, url },
        requestUrl: url,
        responseData,
        httpStatus,
        responseTime,
        failureType: errorType,
        errorMessage: err.message || 'Unknown error',
        errorStack: err.stack,
        platformTxId,
        roundId,
        betAmount,
        winAmount,
        currency,
        callbackUrl: url,
        rawError: JSON.stringify(err),
      }).then(async (auditRecord) => {
        // Create retry job (non-blocking)
        this.createRetryJobSafely({
          platformTxId,
          apiAction: WalletApiAction.SETTLE_BET,
          agentId,
          userId,
          requestPayload: { messageObj, url, payload },
          callbackUrl: url,
          roundId,
          betAmount,
          winAmount,
          currency,
          gamePayloads,
          walletAuditId: auditRecord?.id,
          errorMessage: err.message || 'Unknown error',
        });
      }).catch((auditError) => {
        this.logger.error(
          `Failed to log audit for settleBet: ${auditError?.message || 'Unknown error'}`,
        );
      });

      // Mark bet as settlement failed after all retries exhausted
      try {
        await this.betService.markSettlementFailed(platformTxId, userId);
        this.logger.warn(
          `Marked bet as settlement_failed: txId=${platformTxId} user=${userId}`,
        );
      } catch (betUpdateError) {
        this.logger.error(
          `Failed to mark bet as settlement_failed: txId=${platformTxId} error=${betUpdateError}`,
        );
        // Don't throw - we still want to throw the original error
      }

      throw err;
    }
  }

  async refundBet(
    agentId: string,
    userId: string,
    refundTransactions: Array<{
      platformTxId: string;
      refundPlatformTxId: string;
      betAmount: number;
      winAmount: number;
      turnover?: number;
      betTime: string;
      updateTime: string;
      roundId: string;
      gamePayloads: {
        platform: string;
        gameType: string;
        gameCode: string;
        gameName: string;
        betType?: string | null;
        currency?: string;
      };
      gameInfo?: any;
    }>,
  ): Promise<{
    balance: number;
    balanceTs: string | null;
    status: string;
    userId: string | null;
    raw: any;
  }> {
    const requestId = uuidv4();
    const { callbackURL, cert } = await this.resolveAgent(agentId);
    const url = callbackURL;
    const currency = refundTransactions[0]?.gamePayloads?.currency || DEFAULTS.CURRENCY.DEFAULT;
    const firstTransaction = refundTransactions[0];

    // Build transaction array from refund transactions
    const txns = refundTransactions.map((refundTxn) => {
      const txn: any = {
        platformTxId: refundTxn.platformTxId,
        userId,
        platform: refundTxn.gamePayloads.platform,
        gameType: refundTxn.gamePayloads.gameType,
        gameCode: refundTxn.gamePayloads.gameCode,
        gameName: refundTxn.gamePayloads.gameName,
        betType: refundTxn.gamePayloads.betType ?? null,
        betAmount: Number(refundTxn.betAmount),
        winAmount: Number(refundTxn.winAmount),
        turnover: Number(refundTxn.turnover ?? 0),
        betTime: refundTxn.betTime,
        updateTime: refundTxn.updateTime,
        roundId: refundTxn.roundId,
        refundPlatformTxId: refundTxn.refundPlatformTxId,
      };

      // Add gameInfo if provided
      if (refundTxn.gameInfo) {
        txn.gameInfo = typeof refundTxn.gameInfo === 'string' 
          ? refundTxn.gameInfo 
          : JSON.stringify(refundTxn.gameInfo);
      }

      return txn;
    });

    const messageObj = { action: 'cancelBet', txns };
    const payload = { key: cert, message: JSON.stringify(messageObj) };
    const requestStartTime = Date.now();
    const txIds = txns.map(t => t.platformTxId).join(',');
    this.logger.debug(
      `[WALLET_API_REQUEST] user=${userId} agent=${agentId} action=refundBet url=${url} txCount=${txns.length} txIds=[${txIds}] requestId=${requestId}`,
    );
    try {
      const resp = await firstValueFrom(this.http.post<any>(url, payload));
      const responseTime = Date.now() - requestStartTime;
      const mappedResponse = this.mapAgentResponse(resp.data);
      this.logger.log(
        `[WALLET_API_RESPONSE] user=${userId} agent=${agentId} action=refundBet status=${mappedResponse.status} balance=${mappedResponse.balance} txCount=${txns.length} responseTime=${responseTime}ms`,
      );
      
      // Check if agent rejected the refund (status !== '0000' means failure)
      if (mappedResponse.status !== '0000') {
        const errorMessage = `Agent rejected refund with status: ${mappedResponse.status}`;
        const totalBetAmount = refundTransactions.reduce((sum, txn) => sum + txn.betAmount, 0);
        const totalWinAmount = refundTransactions.reduce((sum, txn) => sum + txn.winAmount, 0);
        
        // Log to audit first (non-blocking)
        this.walletAuditService.logAudit({
          requestId,
          agentId,
          userId,
          apiAction: WalletApiAction.REFUND_BET,
          status: WalletAuditStatus.FAILURE,
          requestPayload: { messageObj, url },
          requestUrl: url,
          responseData: mappedResponse.raw,
          httpStatus: resp.status,
          responseTime,
          failureType: WalletErrorType.AGENT_REJECTED,
          errorMessage,
          platformTxId: firstTransaction?.platformTxId,
          roundId: firstTransaction?.roundId,
          betAmount: totalBetAmount,
          winAmount: totalWinAmount,
          currency,
          callbackUrl: url,
        }).then(async (auditRecord) => {
          // Create retry job for first transaction (non-blocking)
          if (firstTransaction) {
            this.createRetryJobSafely({
              platformTxId: firstTransaction.platformTxId,
              apiAction: WalletApiAction.REFUND_BET,
              agentId,
              userId,
              requestPayload: { messageObj, url, payload, refundTransactions },
              callbackUrl: url,
              roundId: firstTransaction.roundId,
              betAmount: totalBetAmount,
              winAmount: totalWinAmount,
              currency,
              gamePayloads: firstTransaction.gamePayloads,
              walletAuditId: auditRecord?.id,
              errorMessage,
            });
          }
        }).catch((auditError) => {
          this.logger.error(
            `Failed to log audit for refundBet: ${auditError?.message || 'Unknown error'}`,
          );
        });

        // Mark all affected bets as settlement failed when agent rejects
        try {
          for (const refundTxn of refundTransactions) {
            try {
              await this.betService.markSettlementFailed(refundTxn.platformTxId, userId);
              this.logger.warn(
                `Marked bet as settlement_failed (agent rejected): txId=${refundTxn.platformTxId} user=${userId} status=${mappedResponse.status}`,
              );
            } catch (betUpdateError) {
              this.logger.error(
                `Failed to mark bet as settlement_failed: txId=${refundTxn.platformTxId} error=${betUpdateError}`,
              );
            }
          }
        } catch (betUpdateError) {
          this.logger.error(
            `Failed to mark bets as settlement_failed for refund: error=${betUpdateError}`,
          );
        }

        throw new InternalServerErrorException(errorMessage);
      }
      
      // Log success to audit (non-blocking)
      const totalBetAmount = refundTransactions.reduce((sum, txn) => sum + txn.betAmount, 0);
      const totalWinAmount = refundTransactions.reduce((sum, txn) => sum + txn.winAmount, 0);
      this.logAudit({
        requestId,
        agentId,
        userId,
        apiAction: WalletApiAction.REFUND_BET,
        status: WalletAuditStatus.SUCCESS,
        requestPayload: { messageObj, url },
        requestUrl: url,
        responseData: mappedResponse.raw,
        httpStatus: resp.status,
        responseTime,
        platformTxId: firstTransaction?.platformTxId,
        roundId: firstTransaction?.roundId,
        betAmount: totalBetAmount,
        winAmount: totalWinAmount,
        currency,
        callbackUrl: url,
      });
      
      return mappedResponse;
    } catch (err: any) {
      const responseTime = Date.now() - requestStartTime;
      const totalBetAmount = refundTransactions.reduce((sum, txn) => sum + txn.betAmount, 0);
      const totalWinAmount = refundTransactions.reduce((sum, txn) => sum + txn.winAmount, 0);
      this.logger.error(
        `refundBet failed agent=${agentId} user=${userId} requestId=${requestId}`,
        err,
      );

      // Determine error type
      let errorType = WalletErrorType.UNKNOWN_ERROR;
      let httpStatus: number | undefined;
      let responseData: any = null;

      if (err.response) {
        httpStatus = err.response.status;
        responseData = err.response.data;
        errorType = WalletErrorType.HTTP_ERROR;
      } else if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
        errorType = WalletErrorType.NETWORK_ERROR;
      } else if (err.code === 'ETIMEDOUT' || err.name === 'TimeoutError') {
        errorType = WalletErrorType.TIMEOUT_ERROR;
      }

      // Log to audit first (non-blocking), then create retry job
      this.walletAuditService.logAudit({
        requestId,
        agentId,
        userId,
        apiAction: WalletApiAction.REFUND_BET,
        status: WalletAuditStatus.FAILURE,
        requestPayload: { messageObj, url },
        requestUrl: url,
        responseData,
        httpStatus,
        responseTime,
        failureType: errorType,
        errorMessage: err.message || 'Unknown error',
        errorStack: err.stack,
        platformTxId: firstTransaction?.platformTxId,
        roundId: firstTransaction?.roundId,
        betAmount: totalBetAmount,
        winAmount: totalWinAmount,
        currency,
        callbackUrl: url,
        rawError: JSON.stringify(err),
      }).then(async (auditRecord) => {
        // Create retry job for first transaction (non-blocking)
        if (firstTransaction) {
          this.createRetryJobSafely({
            platformTxId: firstTransaction.platformTxId,
            apiAction: WalletApiAction.REFUND_BET,
            agentId,
            userId,
            requestPayload: { messageObj, url, payload, refundTransactions },
            callbackUrl: url,
            roundId: firstTransaction.roundId,
            betAmount: totalBetAmount,
            winAmount: totalWinAmount,
            currency,
            gamePayloads: firstTransaction.gamePayloads,
            walletAuditId: auditRecord?.id,
            errorMessage: err.message || 'Unknown error',
          });
        }
      }).catch((auditError) => {
        this.logger.error(
          `Failed to log audit for refundBet: ${auditError?.message || 'Unknown error'}`,
        );
      });

      // Mark all affected bets as settlement failed after all retries exhausted
      try {
        for (const refundTxn of refundTransactions) {
          try {
            await this.betService.markSettlementFailed(refundTxn.platformTxId, userId);
            this.logger.warn(
              `Marked bet as settlement_failed: txId=${refundTxn.platformTxId} user=${userId}`,
            );
          } catch (betUpdateError) {
            this.logger.error(
              `Failed to mark bet as settlement_failed: txId=${refundTxn.platformTxId} error=${betUpdateError}`,
            );
            // Continue with other transactions
          }
        }
      } catch (betUpdateError) {
        this.logger.error(
          `Failed to mark bets as settlement_failed for refund: error=${betUpdateError}`,
        );
        // Don't throw - we still want to throw the original error
      }

      throw err;
    }
  }
}
