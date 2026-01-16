import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { Agents, AgentsService, JwtTokenService, UserService, CreateUserParams } from '@vector-games/game-core';
import { GameConfigService } from '../../modules/gameConfig/game-config.service';
import { UserSessionService } from '../../modules/user-session/user-session.service';
import { CreateMemberBodyDto } from './DTO/create-member.dto';
import { DEFAULTS } from '../../config/defaults.config';
import { GameService } from '../../modules/games/game.service';

import { ERROR_CODES } from '../../common/constants';

@Injectable()
export class CommonApiFunctionsService {
  private readonly logger = new Logger(CommonApiFunctionsService.name);

  constructor(
    private readonly userService: UserService,
    private readonly gameConfigService: GameConfigService,
    private readonly jwtTokenService: JwtTokenService,
    private readonly userSessionService: UserSessionService,
    private readonly gameService: GameService,
    private readonly agentsService: AgentsService,
  ) {}

  async createMember(
    body: CreateMemberBodyDto,
  ): Promise<{ status: string; desc: string }> {
    this.logger.log(
      `[createMember] Request received - agentId: ${body.agentId}, userId: ${body.userId}, currency: ${body.currency}`,
    );

    const required: (keyof CreateMemberBodyDto)[] = [
      'cert',
      'agentId',
      'userId',
      'currency',
      'betLimit',
    ];
    for (const field of required) {
      if (!body[field] || String(body[field]).trim() === '') {
        this.logger.warn(
          `[createMember] Missing parameter: ${field} - agentId: ${body.agentId}`,
        );
        return {
          status: ERROR_CODES.PARAMETER_MISSING,
          desc: `Missing parameter: ${field}`,
        };
      }
    }

    if (!body.agentId) {
      this.logger.warn(`[createMember] Invalid agentId provided`);
      return {
        status: ERROR_CODES.INVALID_AGENT_ID,
        desc: 'agentId mismatch',
      };
    }

    if (!/^[a-z0-9]+$/.test(body.userId)) {
      this.logger.warn(
        `[createMember] Invalid userId format: ${body.userId} - agentId: ${body.agentId}`,
      );
      return {
        status: ERROR_CODES.INVALID_USER_ID,
        desc: 'Invalid userId format',
      };
    }

    if (!/^[A-Z]{3,4}$/.test(body.currency)) {
      this.logger.warn(
        `[createMember] Invalid currency code: ${body.currency} - userId: ${body.userId}, agentId: ${body.agentId}`,
      );
      return {
        status: ERROR_CODES.INVALID_CURRENCY,
        desc: 'Invalid currency code',
      };
    }

    const params: CreateUserParams = {
      userId: body.userId,
      agentId: body.agentId,
      currency: body.currency,
      language: body.language,
      username: body.userName,
      betLimit: body.betLimit,
      createdBy: body.agentId,
    };
    try {
      this.logger.log(
        `[createMember] Creating user - userId: ${body.userId}, agentId: ${body.agentId}`,
      );
      await this.userService.create(params);
      this.logger.log(
        `[createMember] SUCCESS - User created: ${body.userId}, agentId: ${body.agentId}`,
      );
      return {
        status: ERROR_CODES.SUCCESS,
        desc: 'Member created successfully',
      };
    } catch (err: any) {
      if (err instanceof ConflictException) {
        this.logger.warn(
          `[createMember] Account already exists - userId: ${body.userId}, agentId: ${body.agentId}`,
        );
        return {
          status: ERROR_CODES.ACCOUNT_EXIST,
          desc: 'Account already exists',
        };
      }
      this.logger.error(
        `[createMember] ERROR - userId: ${body.userId}, agentId: ${body.agentId}, error: ${err.message}`,
        err.stack,
      );
      return {
        status: ERROR_CODES.UNABLE_TO_PROCEED,
        desc: 'Unable to proceed',
      };
    }
  }

  async loginMember(
    agent: Agents,
    userId: string,
    agentId: string,
    gameCode: string = 'chicken-road-two',
    ipAddress?: string,
  ): Promise<{
    status: string;
    url?: string;
    extension: any[];
    desc?: string;
  }> {
    this.logger.log(
      `[LOGIN_REQUEST] user=${userId} agent=${agentId} ip=${ipAddress || 'N/A'}`,
    );

    if (agent.agentId !== agentId) {
      this.logger.warn(
        `[loginMember] AgentId mismatch - provided: ${agentId}, expected: ${agent.agentId}`,
      );
      return {
        status: ERROR_CODES.INVALID_AGENT_ID,
        extension: [],
        desc: 'agentId mismatch',
      };
    }
    if (!/^[a-z0-9]+$/.test(userId)) {
      this.logger.warn(
        `[loginMember] Invalid userId format: ${userId} - agentId: ${agentId}`,
      );
      return {
        status: ERROR_CODES.INVALID_USER_ID,
        extension: [],
        desc: 'Invalid userId format',
      };
    }

    this.logger.log(
      `[loginMember] Looking up user - userId: ${userId}, agentId: ${agentId}`,
    );
    const existing = await this.userService.findOne(userId, agentId);
    if (!existing) {
      this.logger.warn(
        `[loginMember] Account not found - userId: ${userId}, agentId: ${agentId}`,
      );
      return {
        status: ERROR_CODES.ACCOUNT_NOT_EXIST,
        extension: [],
        desc: 'Account not found',
      };
    }

    const host = await this.resolveHost(gameCode);
    this.logger.log(
      `[loginMember] Generating JWT token - userId: ${userId}, agentId: ${agentId}, host: ${host}`,
    );
    const token = await this.jwtTokenService.signUserToken(userId, agentId);
    
    const lang = existing.language || DEFAULTS.USER.DEFAULT_LANGUAGE;
    const currency = existing.currency || DEFAULTS.CURRENCY.DEFAULT;
    const adaptive = DEFAULTS.USER.DEFAULT_ADAPTIVE;
    
    const url = `https://${host}/index.html?gameMode=${encodeURIComponent(gameCode)}&operatorId=${encodeURIComponent(agentId)}&lang=${encodeURIComponent(lang)}&currency=${encodeURIComponent(currency)}&adaptive=${encodeURIComponent(adaptive)}&authToken=${encodeURIComponent(token)}`;

    await this.userSessionService.addSession(userId, agentId, gameCode);

    this.logger.log(
      `[LOGIN_SUCCESS] user=${userId} agent=${agentId} ip=${ipAddress || 'N/A'} tokenGenerated=true currency=${currency} gameMode=${gameCode}`,
    );
    return { status: ERROR_CODES.SUCCESS, url, extension: [] };
  }

  async loginAndLaunchGame(
    agent: Agents,
    dto: {
      userId: string;
      agentId: string;
      platform: string;
      gameType: string;
      gameCode: string;
    },
  ): Promise<{
    status: string;
    url?: string;
    extension: any[];
    desc?: string;
  }> {
    this.logger.log(
      `[loginAndLaunchGame] Request received - userId: ${dto.userId}, agentId: ${dto.agentId}, platform: ${dto.platform}, gameType: ${dto.gameType}, gameCode: ${dto.gameCode}`,
    );

    const mandatory: (keyof typeof dto)[] = [
      'agentId',
      'userId',
      'platform',
      'gameType',
      'gameCode',
    ];

    for (const f of mandatory) {
      if (!dto[f] || String(dto[f]).trim() === '') {
        this.logger.warn(
          `[loginAndLaunchGame] Missing parameter: ${f} - userId: ${dto.userId}, agentId: ${dto.agentId}`,
        );
        return {
          status: ERROR_CODES.PARAMETER_MISSING,
          extension: [],
          desc: `Missing parameter: ${f}`,
        };
      }
    }

    this.logger.log(
      `[loginAndLaunchGame] Delegating to loginMember - userId: ${dto.userId}, agentId: ${dto.agentId}`,
    );

    const game = await this.gameService.getGame(dto.gameCode);
    if (!game) {
      this.logger.warn(
        `[loginAndLaunchGame] Game not found - gameCode: ${dto.gameCode}`,
      );
      return {
        status: ERROR_CODES.GAME_NOT_FOUND,
        extension: [],
        desc: 'Game not found',
      };
    }
    
    if (!game.isActive) {
      this.logger.warn(
        `[loginAndLaunchGame] Game is not active - gameCode: ${dto.gameCode}`,
      );
      return {
        status: ERROR_CODES.GAME_NOT_FOUND,
        extension: [],
        desc: 'Game is not active',
      };
    }
    
    // Validate agent has access to this game
    const hasAccess = await this.agentsService.hasGameAccess(dto.agentId, dto.gameCode);
    if (!hasAccess) {
      this.logger.warn(
        `[loginAndLaunchGame] Agent does not have access to game - agentId: ${dto.agentId}, gameCode: ${dto.gameCode}`,
      );
      return {
        status: ERROR_CODES.UNABLE_TO_PROCEED,
        extension: [],
        desc: 'Agent does not have access to this game',
      };
    }
    
    return this.loginMember(agent, dto.userId, dto.agentId, dto.gameCode);
  }

  async logoutUsers(
    agent: Agents,
    agentId: string,
    userIdsCsv: string,
  ): Promise<{
    status: string;
    logoutUsers: string[];
    count: number;
    desc?: string;
  }> {
    this.logger.log(
      `[logoutUsers] Request received - agentId: ${agentId}, userIds: ${userIdsCsv}`,
    );

    if (agent.agentId !== agentId) {
      this.logger.warn(
        `[logoutUsers] AgentId mismatch - provided: ${agentId}, expected: ${agent.agentId}`,
      );
      return {
        status: ERROR_CODES.INVALID_AGENT_ID,
        logoutUsers: [],
        count: 0,
        desc: 'agentId mismatch',
      };
    }

    const logoutUsers = userIdsCsv
      .split(',')
      .map((u) => u.trim())
      .filter(Boolean);

    // Remove users from logged-in sessions
    await this.userSessionService.removeSessions(logoutUsers, agentId);

    this.logger.log(
      `[logoutUsers] SUCCESS - Logged out ${logoutUsers.length} users - agentId: ${agentId}, users: [${logoutUsers.join(', ')}]`,
    );
    return {
      status: ERROR_CODES.SUCCESS,
      logoutUsers,
      count: logoutUsers.length,
    };
  }

  private async resolveHost(gameCode: string): Promise<string> {
    const candidateKey = 'frontend.host';
    try {
      //TODO: Add support for multiple games
      const value = await this.gameConfigService.getConfig(gameCode, candidateKey);
      if (typeof value === 'string' && value.trim()) {
        this.logger.debug(
          `[resolveHost] Using configured host: ${value.trim()}`,
        );
        return value.trim();
      }
      if (value && typeof value === 'object' && 'host' in value) {
        const hostVal = (value as any).host;
        if (typeof hostVal === 'string' && hostVal.trim()) {
          this.logger.debug(
            `[resolveHost] Using configured host from object: ${hostVal.trim()}`,
          );
          return hostVal.trim();
        }
      }
    } catch (e) {
      this.logger.warn(
        `[resolveHost] Failed to resolve host from config, using default: localhost`,
        e,
      );
    }

    this.logger.debug(`[resolveHost] Using default host: ${DEFAULTS.FRONTEND.DEFAULT_HOST}`);
    return DEFAULTS.FRONTEND.DEFAULT_HOST;
  }
}
