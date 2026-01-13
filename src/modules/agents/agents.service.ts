import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, In, Repository } from 'typeorm';
import { Agents } from '@vector-games/game-core';
import { GameService } from '../games/game.service';

export interface CreateAgentParams {
  agentId: string;
  cert: string;
  agentIPaddress: string;
  callbackURL: string;
  isWhitelisted?: boolean;
  createdBy: string;
}

export interface UpdateAgentParams {
  cert?: string;
  agentIPaddress?: string;
  callbackURL?: string;
  isWhitelisted?: boolean;
  updatedBy: string;
}

const ERROR_MESSAGES = {
  AGENT_EXISTS: 'Agent already exists',
  AGENT_NOT_FOUND: 'Agent not found',
} as const;

@Injectable()
export class AgentsService {
  private readonly logger = new Logger(AgentsService.name);

  constructor(
    @InjectRepository(Agents) private readonly repo: Repository<Agents>,
    private readonly gameService: GameService,
  ) { }

  private whereById(agentId: string): FindOptionsWhere<Agents> {
    return { agentId };
  }

  async create(params: CreateAgentParams): Promise<Agents> {
    const existing = await this.repo.findOne({
      where: this.whereById(params.agentId),
    });
    if (existing) {
      this.logger.warn(`Attempt to create duplicate agent: ${params.agentId}`);
      throw new ConflictException(ERROR_MESSAGES.AGENT_EXISTS);
    }
    const entity = this.repo.create({
      agentId: params.agentId,
      cert: params.cert,
      agentIPaddress: params.agentIPaddress,
      callbackURL: params.callbackURL,
      isWhitelisted: params.isWhitelisted ?? true,
      createdBy: params.createdBy,
      updatedBy: params.createdBy,
    });
    const saved = await this.repo.save(entity);
    this.logger.log(`Agent created: ${params.agentId}`);
    return saved;
  }

  async upsert(params: CreateAgentParams): Promise<Agents> {
    const existing = await this.repo.findOne({
      where: this.whereById(params.agentId),
    });
    if (!existing) {
      return this.create(params);
    }
    existing.cert = params.cert;
    existing.agentIPaddress = params.agentIPaddress;
    existing.callbackURL = params.callbackURL;
    existing.isWhitelisted = params.isWhitelisted ?? existing.isWhitelisted;
    existing.updatedBy = params.createdBy;
    return this.repo.save(existing);
  }

  async findAll(): Promise<Agents[]> {
    return this.repo.find();
  }

  async findAllWhitelisted(): Promise<Agents[]> {
    return this.repo.find({ where: { isWhitelisted: true } });
  }

  async findOne(agentId: string): Promise<Agents | null> {
    return this.repo.findOne({ where: this.whereById(agentId) });
  }

  async update(agentId: string, params: UpdateAgentParams): Promise<Agents> {
    const agent = await this.findOne(agentId);
    if (!agent) {
      this.logger.warn(`Update failed: agent not found (${agentId})`);
      throw new NotFoundException(ERROR_MESSAGES.AGENT_NOT_FOUND);
    }
    if (params.cert !== undefined) agent.cert = params.cert;
    if (params.agentIPaddress !== undefined)
      agent.agentIPaddress = params.agentIPaddress;
    if (params.callbackURL !== undefined)
      agent.callbackURL = params.callbackURL;
    if (params.isWhitelisted !== undefined)
      agent.isWhitelisted = params.isWhitelisted;
    agent.updatedBy = params.updatedBy;
    const updated = await this.repo.save(agent);
    this.logger.log(`Agent updated: ${agentId}`);
    return updated;
  }

  async toggleWhitelist(
    agentId: string,
    updatedBy: string,
    value?: boolean,
  ): Promise<Agents> {
    const agent = await this.findOne(agentId);
    if (!agent) {
      this.logger.warn(`Toggle whitelist failed: agent not found (${agentId})`);
      throw new NotFoundException(ERROR_MESSAGES.AGENT_NOT_FOUND);
    }
    agent.isWhitelisted = value !== undefined ? value : !agent.isWhitelisted;
    agent.updatedBy = updatedBy;
    const updated = await this.repo.save(agent);
    this.logger.log(
      `Agent whitelist toggled: ${agentId} (isWhitelisted=${agent.isWhitelisted})`,
    );
    return updated;
  }

  async remove(agentId: string): Promise<boolean> {
    const res = await this.repo.delete(this.whereById(agentId));
    const success = res.affected === 1;
    if (success) {
      this.logger.log(`Agent removed: ${agentId}`);
    }
    return success;
  }

  async findByIP(ip: string): Promise<Agents[]> {
    return this.repo.find({ where: { agentIPaddress: ip } });
  }

  async findByCallbackURL(callbackURL: string): Promise<Agents[]> {
    return this.repo.find({ where: { callbackURL } });
  }

  /**
   * Check if agent has access to a specific game
   * If allowedGameCodes is null or empty, agent has access to all games (backward compatibility)
   * @param agentId Agent ID
   * @param gameCode Game code to check
   * @returns true if agent has access, false otherwise
   */
  async hasGameAccess(agentId: string, gameCode: string): Promise<boolean> {
    const agent = await this.findOne(agentId);
    if (!agent) {
      return false;
    }
    
    // If allowedGameCodes is null or empty, agent has access to all games
    if (!agent.allowedGameCodes || agent.allowedGameCodes.length === 0) {
      return true;
    }
    
    // Otherwise, check if gameCode is in the allowed list
    return agent.allowedGameCodes.includes(gameCode);
  }

  async addGameAccess(agentId: string, gameCode: string): Promise<Agents> {
    //check if the gameCode is valid
    const game = await this.gameService.getGame(gameCode);
    if (!game) {
      throw new NotFoundException(`Game with code ${gameCode} not found`);
    }
    const agent = await this.findOne(agentId);
    if (!agent) {
      throw new NotFoundException(`Agent with id ${agentId} not found`);
    }
    agent.allowedGameCodes = [...(agent.allowedGameCodes ?? []), gameCode];
    return this.repo.save(agent);
  }

  async findAgentsByGame(gameCode: string): Promise<Agents[]> {
    return this.repo.find({ where: { allowedGameCodes: In([gameCode]) } });
  }
}
