import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { AgentsService } from '@vector-games/game-core';

import { GameConfigService } from '../modules/gameConfig/game-config.service';

const AUTH_CONSTANTS = {
  IP_HEADER_CACHE_MS: 60_000,
  DEFAULT_IP_HEADER: 'x-real-ip',
  FALLBACK_IP_HEADERS: ['x-real-ip', 'x-forwarded-for'] as const,
  IPV6_PREFIX: '::ffff:',
  WILDCARD_CHAR: '*',
  IP_DELIMITER: ',',
  CONFIG_KEY: 'agent.ipHeader',
} as const;

const ERROR_MESSAGES = {
  MISSING_CREDENTIALS: 'Missing agentId or cert in request body',
  AGENT_NOT_FOUND: 'Agent not found',
  AGENT_NOT_WHITELISTED: 'Agent not whitelisted',
  INVALID_CERT: 'Invalid cert',
  IP_MISMATCH: 'IP mismatch',
} as const;

interface IpHeaderCache {
  header: string;
  expires: number;
}

@Injectable()
export class AgentAuthGuard implements CanActivate {
  private readonly logger = new Logger(AgentAuthGuard.name);
  private ipHeaderCache?: IpHeaderCache;

  constructor(
    private readonly agentsService: AgentsService,
    private readonly configService: ConfigService,
    private readonly gameConfigService: GameConfigService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req: Request = ctx.switchToHttp().getRequest();

    if (!this.isAuthEnabled()) {
      return true;
    }

    const { agentId, cert, gameCode } = this.extractCredentials(req);
    const clientIp = await this.extractClientIp(req, gameCode);

    await this.validateAgent(agentId, cert, clientIp);

    (req as any).agent = await this.agentsService.findOne(agentId);
    return true;
  }

  private isAuthEnabled(): boolean {
    return this.configService.get<boolean>('app.enableAuth') !== false;
  }

  private extractCredentials(req: Request): { agentId: string; cert: string, gameCode: string } {
    const body: any = req.body || {};
    const agentId: string | undefined = body.agentId;
    const cert: string | undefined = body.cert;
    const gameCode: string | undefined = body.gameCode;

    if (!agentId || !cert || !gameCode) {
      this.logger.warn('Authentication attempt with missing credentials');
      throw new UnauthorizedException(ERROR_MESSAGES.MISSING_CREDENTIALS);
    }

    return { agentId, cert, gameCode };
  }

  private async extractClientIp(req: Request, gameCode: string): Promise<string> {
    const headerIp = await this.extractIpFromHeader(req, gameCode);
    const rawIp =
      headerIp || req.ip || (req.socket && req.socket.remoteAddress) || '';
    return this.normalizeIp(rawIp);
  }

  private async validateAgent(
    agentId: string,
    cert: string,
    clientIp: string,
  ): Promise<void> {
    const agent = await this.agentsService.findOne(agentId);

    if (!agent) {
      this.logger.warn(`Authentication failed: agent not found (${agentId})`);
      throw new UnauthorizedException(ERROR_MESSAGES.AGENT_NOT_FOUND);
    }

    if (!agent.isWhitelisted) {
      this.logger.warn(
        `Authentication failed: agent not whitelisted (${agentId})`,
      );
      throw new ForbiddenException(ERROR_MESSAGES.AGENT_NOT_WHITELISTED);
    }

    if (agent.cert !== cert) {
      this.logger.warn(`Authentication failed: invalid cert (${agentId})`);
      throw new UnauthorizedException(ERROR_MESSAGES.INVALID_CERT);
    }

    if (!this.ipMatches(agent.agentIPaddress, clientIp)) {
      this.logger.warn(
        `Authentication failed: IP mismatch (${agentId}, expected: ${agent.agentIPaddress}, got: ${clientIp})`,
      );
      throw new UnauthorizedException(ERROR_MESSAGES.IP_MISMATCH);
    }
  }

  private normalizeIp(ip: string): string {
    if (!ip) return '';

    let normalized = ip;

    if (normalized.includes(AUTH_CONSTANTS.IP_DELIMITER)) {
      normalized = normalized.split(AUTH_CONSTANTS.IP_DELIMITER)[0].trim();
    }

    if (normalized.startsWith(AUTH_CONSTANTS.IPV6_PREFIX)) {
      normalized = normalized.substring(AUTH_CONSTANTS.IPV6_PREFIX.length);
    }

    return normalized;
  }

  private ipMatches(expectedPattern: string, actualIp: string): boolean {
    if (!expectedPattern || !actualIp) return false;

    const patterns = expectedPattern
      .split(AUTH_CONSTANTS.IP_DELIMITER)
      .map((p) => p.trim())
      .filter(Boolean);

    return patterns.some((pattern) => this.matchIpPattern(pattern, actualIp));
  }

  private matchIpPattern(pattern: string, ip: string): boolean {
    if (pattern === ip) return true;

    if (pattern.endsWith(AUTH_CONSTANTS.WILDCARD_CHAR)) {
      const prefix = pattern.slice(0, -1);
      return ip.startsWith(prefix);
    }

    return false;
  }

  private async extractIpFromHeader(req: Request, gameCode: string): Promise<string | undefined> {
    const configuredHeader = await this.getConfiguredIpHeader(gameCode);

    if (configuredHeader) {
      const value = req.headers[configuredHeader.toLowerCase()];
      if (value) return value as string;
    }

    for (const fallbackHeader of AUTH_CONSTANTS.FALLBACK_IP_HEADERS) {
      const value = req.headers[fallbackHeader];
      if (value) return value as string;
    }

    return undefined;
  }

  private async getConfiguredIpHeader(gameCode: string): Promise<string | undefined> {
    if (this.isCacheValid()) {
      return this.ipHeaderCache!.header;
    }

    const header = await this.fetchIpHeaderFromConfig(gameCode);
    this.updateCache(header);

    return header;
  }

  private isCacheValid(): boolean {
    return (
      this.ipHeaderCache !== undefined &&
      this.ipHeaderCache.expires > Date.now()
    );
  }

  private async fetchIpHeaderFromConfig(gameCode: string): Promise<string | undefined> {
    //TODO: Add support for multiple games
    try {
      const raw = await this.gameConfigService.getConfig(
        gameCode,
        AUTH_CONSTANTS.CONFIG_KEY,
      );

      if (typeof raw === 'string') {
        return raw.trim();
      }

      if (raw && typeof raw === 'object' && 'header' in raw) {
        const headerValue = (raw as any).header;
        if (typeof headerValue === 'string') {
          return headerValue.trim();
        }
      }
    } catch (error) {
      this.logger.debug('Failed to fetch IP header config, using default');
    }

    return undefined;
  }

  private updateCache(header: string | undefined): void {
    this.ipHeaderCache = {
      header: header || AUTH_CONSTANTS.DEFAULT_IP_HEADER,
      expires: Date.now() + AUTH_CONSTANTS.IP_HEADER_CACHE_MS,
    };
  }
}
