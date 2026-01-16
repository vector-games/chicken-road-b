import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, Repository } from 'typeorm';
import { User } from '@vector-games/game-core';

export interface CreateUserParams {
  userId: string;
  agentId: string;
  currency: string;
  language?: string;
  username?: string;
  betLimit: string;
  createdBy: string;
}

export interface UpdateUserParams {
  currency?: string;
  language?: string;
  username?: string;
  betLimit?: string;
  updatedBy: string;
}

const ERROR_MESSAGES = {
  USER_EXISTS: 'User already exists',
  USER_NOT_FOUND: 'User not found',
} as const;

@Injectable()
export class UserService {
  private readonly logger = new Logger(UserService.name);

  constructor(
    @InjectRepository(User) private readonly repo: Repository<User>,
  ) {}

  private compositeWhere(
    userId: string,
    agentId: string,
  ): FindOptionsWhere<User> {
    return { userId, agentId };
  }

  async create(params: CreateUserParams): Promise<User> {
    const existing = await this.repo.findOne({
      where: this.compositeWhere(params.userId, params.agentId),
    });
    if (existing) {
      this.logger.warn(
        `Attempt to create duplicate user: ${params.userId} (agent: ${params.agentId})`,
      );
      throw new ConflictException(ERROR_MESSAGES.USER_EXISTS);
    }
    const entity = this.repo.create({
      userId: params.userId,
      agentId: params.agentId,
      currency: params.currency,
      language: params.language,
      username: params.username,
      betLimit: params.betLimit,
      createdBy: params.createdBy,
      updatedBy: params.createdBy,
    });
    const saved = await this.repo.save(entity);
    this.logger.log(
      `User created: ${params.userId} (agent: ${params.agentId})`,
    );
    return saved;
  }

  async upsert(params: CreateUserParams): Promise<User> {
    const existing = await this.repo.findOne({
      where: this.compositeWhere(params.userId, params.agentId),
    });
    if (!existing) {
      return this.create(params);
    }
    existing.currency = params.currency;
    existing.language = params.language;
    existing.username = params.username;
    existing.betLimit = params.betLimit;
    existing.updatedBy = params.createdBy;
    return this.repo.save(existing);
  }

  async findAll(): Promise<User[]> {
    return this.repo.find();
  }

  async findAllByAgent(agentId: string): Promise<User[]> {
    return this.repo.find({ where: { agentId } });
  }

  async findOne(userId: string, agentId: string): Promise<User> {
    const user = await this.repo.findOne({ where: this.compositeWhere(userId, agentId) });
    if (!user) {
      this.logger.warn(
        `User not found: ${userId} (agent: ${agentId})`,
      );
      throw new NotFoundException(ERROR_MESSAGES.USER_NOT_FOUND);
    }
    return user;
  }

  async findByUsername(username: string, agentId?: string): Promise<User[]> {
    if (agentId) {
      return this.repo.find({ where: { username, agentId } });
    }
    return this.repo.find({ where: { username } });
  }

  async update(
    userId: string,
    agentId: string,
    params: UpdateUserParams,
  ): Promise<User> {
    const user = await this.findOne(userId, agentId);
    if (!user) {
      this.logger.warn(
        `Update failed: user not found (${userId}, agent: ${agentId})`,
      );
      throw new NotFoundException(ERROR_MESSAGES.USER_NOT_FOUND);
    }
    if (params.currency !== undefined) user.currency = params.currency;
    if (params.language !== undefined) user.language = params.language;
    if (params.username !== undefined) user.username = params.username;
    if (params.betLimit !== undefined) user.betLimit = params.betLimit;
    user.updatedBy = params.updatedBy;
    const updated = await this.repo.save(user);
    this.logger.log(`User updated: ${userId} (agent: ${agentId})`);
    return updated;
  }

  async remove(userId: string, agentId: string): Promise<boolean> {
    const res = await this.repo.delete(this.compositeWhere(userId, agentId));
    const success = res.affected === 1;
    if (success) {
      this.logger.log(`User removed: ${userId} (agent: ${agentId})`);
    }
    return success;
  }
}
