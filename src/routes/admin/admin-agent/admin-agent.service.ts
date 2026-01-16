import { Injectable, BadRequestException, NotFoundException, Logger, ConflictException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { Bet, Agents } from '@vector-games/game-core';
import { Game } from '../../../entities/game.entity';
import { Admin, AdminRole } from '../../../entities/admin.entity';
import { AgentQueryDto } from './dto/agent-query.dto';
import { AgentResponseDto } from './dto/agent-response.dto';
import { AgentTotalsDto } from './dto/agent-totals.dto';
import { AgentFilterOptionsDto } from './dto/agent-filter-options.dto';
import { AgentListResponseDto } from './dto/agent-list-response.dto';
import { UpdateAgentDto } from './dto/update-agent.dto';
import { CreateAgentDto } from './dto/create-agent.dto';
import * as bcrypt from 'bcrypt';

@Injectable()
export class AdminAgentService {
    private readonly logger = new Logger(AdminAgentService.name);

    constructor(
        @InjectRepository(Bet)
        private readonly betRepository: Repository<Bet>,
        @InjectRepository(Game)
        private readonly gameRepository: Repository<Game>,
        @InjectRepository(Agents)
        private readonly agentsRepository: Repository<Agents>,
        @InjectRepository(Admin)
        private readonly adminRepository: Repository<Admin>,
        private readonly dataSource: DataSource,
    ) {}

    /**
     * Get agent statistics grouped by agent-platform-game combination
     * @param queryDto Query parameters
     * @param adminAgentId Agent ID of the logged-in admin (null for Super Admin)
     */
    async findAll(
        queryDto: AgentQueryDto,
        adminAgentId?: string | null,
    ): Promise<{ agents: AgentResponseDto[]; pagination: { page: number; limit: number; total: number; totalPages: number } }> {
        const page = queryDto.page || 1;
        const limit = queryDto.limit || 20;
        const skip = (page - 1) * limit;

        // Parse and validate date range
        const fromDate = queryDto.fromDate ? new Date(queryDto.fromDate) : null;
        const toDate = queryDto.toDate ? new Date(queryDto.toDate) : null;

        if (!fromDate || !toDate) {
            throw new BadRequestException('Date range (fromDate and toDate) is required');
        }

        // Set time to include entire date range
        fromDate.setHours(0, 0, 0, 0);
        toDate.setHours(23, 59, 59, 999);

        if (fromDate > toDate) {
            throw new BadRequestException('fromDate must be less than or equal to toDate');
        }

        // Build query with LEFT JOIN to Game table to get platform
        const queryBuilder = this.betRepository
            .createQueryBuilder('bet')
            .leftJoin(Game, 'game', 'bet.gameCode = game.gameCode')
            .select([
                'bet.operatorId as agentId',
                'COALESCE(game.platform, "UNKNOWN") as platform',
                'bet.gameCode as game',
                'COUNT(DISTINCT bet.id) as betCount',
                'SUM(CASE WHEN bet.status NOT IN ("REFUNDED", "CANCELLED") THEN CAST(bet.betAmount AS DECIMAL(18,3)) ELSE 0 END) as betAmount',
                'SUM(CASE WHEN bet.status NOT IN ("REFUNDED", "CANCELLED") THEN CAST(bet.betAmount AS DECIMAL(18,3)) - COALESCE(CAST(bet.winAmount AS DECIMAL(18,3)), 0) ELSE 0 END) as winLoss',
                'SUM(CASE WHEN bet.status NOT IN ("REFUNDED", "CANCELLED") THEN CAST(bet.betAmount AS DECIMAL(18,3)) - COALESCE(CAST(bet.winAmount AS DECIMAL(18,3)), 0) ELSE 0 END) as totalWinLoss',
                'SUM(CASE WHEN bet.status NOT IN ("REFUNDED", "CANCELLED") THEN CAST(bet.betAmount AS DECIMAL(18,3)) ELSE 0 END) as totalBetAmount',
                'SUM(CASE WHEN bet.status NOT IN ("REFUNDED", "CANCELLED") AND bet.winAmount IS NOT NULL THEN CAST(bet.winAmount AS DECIMAL(18,3)) ELSE 0 END) as totalWinAmount',
            ])
            .where('bet.betPlacedAt >= :fromDate', { fromDate })
            .andWhere('bet.betPlacedAt <= :toDate', { toDate })
            .groupBy('bet.operatorId')
            .addGroupBy('game.platform')
            .addGroupBy('bet.gameCode');

        // For Agent Admin, force filter to their own agentId (ignore queryDto.agentId)
        if (adminAgentId) {
            queryBuilder.andWhere('bet.operatorId = :adminAgentId', { adminAgentId });
        } else if (queryDto.agentId) {
            // Super Admin can filter by any agentId
            queryBuilder.andWhere('bet.operatorId = :agentId', { agentId: queryDto.agentId });
        }

        if (queryDto.platform) {
            queryBuilder.andWhere('game.platform = :platform', { platform: queryDto.platform });
        }

        if (queryDto.game) {
            queryBuilder.andWhere('bet.gameCode = :game', { game: queryDto.game });
        }

        // Get total count of groups (not individual bets)
        // We need to count distinct agent-platform-game combinations
        const countQuery = this.betRepository
            .createQueryBuilder('bet')
            .leftJoin(Game, 'game', 'bet.gameCode = game.gameCode')
            .select('COUNT(DISTINCT CONCAT(bet.operatorId, "-", COALESCE(game.platform, "UNKNOWN"), "-", bet.gameCode))', 'total')
            .where('bet.betPlacedAt >= :fromDate', { fromDate })
            .andWhere('bet.betPlacedAt <= :toDate', { toDate });

        // Apply same filters to count query
        if (adminAgentId) {
            countQuery.andWhere('bet.operatorId = :adminAgentId', { adminAgentId });
        } else if (queryDto.agentId) {
            countQuery.andWhere('bet.operatorId = :agentId', { agentId: queryDto.agentId });
        }
        if (queryDto.platform) {
            countQuery.andWhere('game.platform = :platform', { platform: queryDto.platform });
        }
        if (queryDto.game) {
            countQuery.andWhere('bet.gameCode = :game', { game: queryDto.game });
        }

        const countResult = await countQuery.getRawOne();
        const total = parseInt(countResult?.total || '0', 10);

        // Apply pagination
        queryBuilder.skip(skip).limit(limit);

        // Execute query
        const rawResults = await queryBuilder.getRawMany();

        // Transform results to DTOs
        const agents: AgentResponseDto[] = rawResults.map((row) => {
            const betAmount = parseFloat(row.betAmount || '0');
            const totalWinAmount = parseFloat(row.totalWinAmount || '0');
            const winLoss = parseFloat(row.winLoss || '0');
            const marginPercent = betAmount > 0 
                ? ((betAmount - totalWinAmount) / betAmount) * 100 
                : 0;
            const companyTotalWinLoss = betAmount - totalWinAmount;

            const dto = new AgentResponseDto();
            dto.agentId = row.agentId;
            dto.platform = row.platform || 'UNKNOWN';
            dto.game = row.game;
            dto.betCount = parseInt(row.betCount || '0', 10);
            dto.betAmount = betAmount.toFixed(2);
            dto.winLoss = winLoss.toFixed(2);
            dto.adjustment = '0.00'; // Always 0.00 for now
            dto.totalWinLoss = winLoss.toFixed(2); // winLoss + adjustment (adjustment is 0)
            dto.marginPercent = parseFloat(marginPercent.toFixed(2));
            dto.companyTotalWinLoss = companyTotalWinLoss.toFixed(2);
            
            return dto;
        });

        const totalPages = Math.ceil(total / limit);

        return {
            agents,
            pagination: {
                page,
                limit,
                total,
                totalPages,
            },
        };
    }

    /**
     * Get agent totals (aggregated across all matching records)
     * @param queryDto Query parameters
     * @param adminAgentId Agent ID of the logged-in admin (null for Super Admin)
     */
    async getTotals(
        queryDto: AgentQueryDto,
        adminAgentId?: string | null,
    ): Promise<AgentTotalsDto> {
        // Parse and validate date range
        const fromDate = queryDto.fromDate ? new Date(queryDto.fromDate) : null;
        const toDate = queryDto.toDate ? new Date(queryDto.toDate) : null;

        if (!fromDate || !toDate) {
            throw new BadRequestException('Date range (fromDate and toDate) is required');
        }

        // Set time to include entire date range
        fromDate.setHours(0, 0, 0, 0);
        toDate.setHours(23, 59, 59, 999);

        if (fromDate > toDate) {
            throw new BadRequestException('fromDate must be less than or equal to toDate');
        }

        // Build query with LEFT JOIN to Game table
        const queryBuilder = this.betRepository
            .createQueryBuilder('bet')
            .leftJoin(Game, 'game', 'bet.gameCode = game.gameCode')
            .select([
                'COUNT(DISTINCT bet.id) as totalBetCount',
                'SUM(CASE WHEN bet.status NOT IN ("REFUNDED", "CANCELLED") THEN CAST(bet.betAmount AS DECIMAL(18,3)) ELSE 0 END) as totalBetAmount',
                'SUM(CASE WHEN bet.status NOT IN ("REFUNDED", "CANCELLED") THEN CAST(bet.betAmount AS DECIMAL(18,3)) - COALESCE(CAST(bet.winAmount AS DECIMAL(18,3)), 0) ELSE 0 END) as totalWinLoss',
                'SUM(CASE WHEN bet.status NOT IN ("REFUNDED", "CANCELLED") THEN CAST(bet.betAmount AS DECIMAL(18,3)) ELSE 0 END) as totalBetAmountForMargin',
                'SUM(CASE WHEN bet.status NOT IN ("REFUNDED", "CANCELLED") AND bet.winAmount IS NOT NULL THEN CAST(bet.winAmount AS DECIMAL(18,3)) ELSE 0 END) as totalWinAmount',
            ])
            .where('bet.betPlacedAt >= :fromDate', { fromDate })
            .andWhere('bet.betPlacedAt <= :toDate', { toDate });

        // For Agent Admin, force filter to their own agentId (ignore queryDto.agentId)
        if (adminAgentId) {
            queryBuilder.andWhere('bet.operatorId = :adminAgentId', { adminAgentId });
        } else if (queryDto.agentId) {
            // Super Admin can filter by any agentId
            queryBuilder.andWhere('bet.operatorId = :agentId', { agentId: queryDto.agentId });
        }

        if (queryDto.platform) {
            queryBuilder.andWhere('game.platform = :platform', { platform: queryDto.platform });
        }

        if (queryDto.game) {
            queryBuilder.andWhere('bet.gameCode = :game', { game: queryDto.game });
        }

        const result = await queryBuilder.getRawOne();

        const totalBetAmount = parseFloat(result?.totalBetAmount || '0');
        const totalWinAmount = parseFloat(result?.totalWinAmount || '0');
        const totalWinLoss = parseFloat(result?.totalWinLoss || '0');
        const totalBetCount = parseInt(result?.totalBetCount || '0', 10);
        const marginPercent = totalBetAmount > 0 
            ? ((totalBetAmount - totalWinAmount) / totalBetAmount) * 100 
            : 0;
        const companyTotalWinLoss = totalBetAmount - totalWinAmount;

        const totals = new AgentTotalsDto();
        totals.totalBetCount = totalBetCount;
        totals.totalBetAmount = totalBetAmount.toFixed(2);
        totals.totalWinLoss = totalWinLoss.toFixed(2);
        totals.totalMarginPercent = parseFloat(marginPercent.toFixed(2));
        totals.companyTotalWinLoss = companyTotalWinLoss.toFixed(2);

        return totals;
    }

    /**
     * Get distinct filter options for agents
     * Returns distinct values for games, platforms, and agentIds
     * @param adminRole Role of the logged-in admin
     * @param adminAgentId Agent ID of the logged-in admin (null for Super Admin)
     */
    async getFilterOptions(
        adminRole: string,
        adminAgentId?: string | null,
    ): Promise<AgentFilterOptionsDto> {
        // Build base query with agent filter if needed
        let baseWhere = '';
        let baseParams: any = {};
        if (adminAgentId) {
            baseWhere = 'bet.operatorId = :adminAgentId';
            baseParams = { adminAgentId };
        }

        // Get distinct game codes from bets (filtered by agent if Agent Admin)
        const gameQuery = this.betRepository.createQueryBuilder('bet')
            .select('DISTINCT bet.gameCode', 'gameCode')
            .where('bet.gameCode IS NOT NULL')
            .andWhere('bet.gameCode != ""');
        
        if (adminAgentId) {
            gameQuery.andWhere(baseWhere, baseParams);
        }
        
        const gameResults = await gameQuery.getRawMany();
        const games = gameResults.map((r) => r.gameCode).filter(Boolean).sort();

        // Get distinct platforms from games table (only for games that have bets, filtered by agent if Agent Admin)
        const platformQuery = this.betRepository.createQueryBuilder('bet')
            .leftJoin(Game, 'game', 'game.gameCode = bet.gameCode AND game.isActive = 1')
            .select('DISTINCT game.platform', 'platform')
            .where('game.platform IS NOT NULL')
            .andWhere('game.platform != ""');
        
        if (adminAgentId) {
            platformQuery.andWhere(baseWhere, baseParams);
        }
        
        const platformResults = await platformQuery.getRawMany();
        const platforms = platformResults.map((r) => r.platform).filter(Boolean).sort();

        // Get distinct agent IDs (only for Super Admin, not returned for Agent Admin)
        let agentIds: string[] | undefined;
        if (adminRole === AdminRole.SUPER_ADMIN) {
            const agentQuery = this.betRepository.createQueryBuilder('bet')
                .select('DISTINCT bet.operatorId', 'operatorId')
                .where('bet.operatorId IS NOT NULL')
                .andWhere('bet.operatorId != ""');
            
            const agentResults = await agentQuery.getRawMany();
            agentIds = agentResults.map((r) => r.operatorId).filter(Boolean).sort();
        }

        return {
            games,
            platforms,
            agentIds,
        };
    }

    /**
     * Get all agents (for agent management page)
     */
    async findAllAgents(): Promise<AgentListResponseDto[]> {
        const agents = await this.agentsRepository.find({
            order: { createdAt: 'DESC' },
        });

        return agents.map((agent) => {
            const dto = new AgentListResponseDto();
            dto.agentId = agent.agentId;
            dto.cert = agent.cert;
            dto.agentIPaddress = agent.agentIPaddress;
            dto.callbackURL = agent.callbackURL;
            dto.isWhitelisted = agent.isWhitelisted;
            dto.currency = agent.currency;
            dto.allowedGameCodes = agent.allowedGameCodes;
            dto.createdAt = agent.createdAt.toISOString();
            dto.updatedAt = agent.updatedAt.toISOString();
            return dto;
        });
    }

    /**
     * Get single agent by ID
     */
    async findOneAgent(agentId: string): Promise<AgentListResponseDto> {
        const agent = await this.agentsRepository.findOne({
            where: { agentId },
        });

        if (!agent) {
            throw new NotFoundException(`Agent with ID ${agentId} not found`);
        }

        const dto = new AgentListResponseDto();
        dto.agentId = agent.agentId;
        dto.cert = agent.cert;
        dto.agentIPaddress = agent.agentIPaddress;
        dto.callbackURL = agent.callbackURL;
        dto.isWhitelisted = agent.isWhitelisted;
        dto.currency = agent.currency;
        dto.allowedGameCodes = agent.allowedGameCodes;
        dto.createdAt = agent.createdAt.toISOString();
        dto.updatedAt = agent.updatedAt.toISOString();
        return dto;
    }

    /**
     * Update agent
     */
    async updateAgent(
        agentId: string,
        updateDto: UpdateAgentDto,
        adminId: string,
    ): Promise<AgentListResponseDto> {
        const agent = await this.agentsRepository.findOne({
            where: { agentId },
        });

        if (!agent) {
            throw new NotFoundException(`Agent with ID ${agentId} not found`);
        }

        // Build update object with only provided fields
        const updateData: Partial<Agents> = {
            updatedBy: adminId,
        };

        if (updateDto.cert !== undefined) {
            updateData.cert = updateDto.cert;
        }
        if (updateDto.agentIPaddress !== undefined) {
            updateData.agentIPaddress = updateDto.agentIPaddress;
        }
        if (updateDto.callbackURL !== undefined) {
            updateData.callbackURL = updateDto.callbackURL;
        }
        if (updateDto.isWhitelisted !== undefined) {
            updateData.isWhitelisted = updateDto.isWhitelisted;
        }
        if (updateDto.currency !== undefined) {
            updateData.currency = updateDto.currency;
        }
        if (updateDto.allowedGameCodes !== undefined) {
            // Explicitly set the array (even if empty) to ensure TypeORM detects the change
            updateData.allowedGameCodes = Array.isArray(updateDto.allowedGameCodes) 
                ? updateDto.allowedGameCodes 
                : [];
        }

        // Use update() method to ensure JSON column changes are properly persisted
        await this.agentsRepository.update(
            { agentId },
            updateData
        );

        return this.findOneAgent(agentId);
    }

    /**
     * Delete agent and associated admin account
     * Uses database transaction to ensure both are deleted or both fail
     */
    async deleteAgent(agentId: string): Promise<void> {
        // Check if agent exists
        const agent = await this.agentsRepository.findOne({
            where: { agentId },
        });

        if (!agent) {
            throw new NotFoundException(`Agent with ID ${agentId} not found`);
        }

        // Check if admin exists (admin username = agentId)
        const admin = await this.adminRepository.findOne({
            where: { username: agentId },
        });

        // Use transaction to ensure both deletions happen together
        const queryRunner = this.dataSource.createQueryRunner();
        await queryRunner.connect();
        await queryRunner.startTransaction();

        try {
            // Delete agent
            await queryRunner.manager.remove(agent);

            // Delete admin if it exists
            if (admin) {
                await queryRunner.manager.remove(admin);
            }

            // Commit transaction
            await queryRunner.commitTransaction();
        } catch (error) {
            // Rollback transaction on error
            await queryRunner.rollbackTransaction();
            this.logger.error(`Failed to delete agent: ${error.message}`, error.stack);
            throw error;
        } finally {
            // Release query runner
            await queryRunner.release();
        }
    }

    /**
     * Create a new agent and associated admin account
     * Uses database transaction to ensure both are created or both fail
     */
    async createAgent(createDto: CreateAgentDto): Promise<AgentListResponseDto> {
        // Check if agent already exists
        const existingAgent = await this.agentsRepository.findOne({ where: { agentId: createDto.agentId } });
        if (existingAgent) {
            throw new ConflictException(`Agent with ID "${createDto.agentId}" already exists`);
        }

        // Check if admin username (agentId) already exists
        const existingAdmin = await this.adminRepository.findOne({ where: { username: createDto.agentId } });
        if (existingAdmin) {
            throw new ConflictException(`Admin with username "${createDto.agentId}" already exists`);
        }

        // Use transaction to ensure both admin and agent are created together
        const queryRunner = this.dataSource.createQueryRunner();
        await queryRunner.connect();
        await queryRunner.startTransaction();

        try {
            // Hash password for admin
            const passwordHash = await bcrypt.hash(createDto.password, 10);

            // Create admin account
            const admin = this.adminRepository.create({
                username: createDto.agentId, // Admin username is same as agentId
                passwordHash,
                role: AdminRole.ADMIN,
            });
            const savedAdmin = await queryRunner.manager.save(admin);

            // Create agent
            const agent = this.agentsRepository.create({
                agentId: createDto.agentId,
                cert: createDto.cert,
                agentIPaddress: createDto.agentIPaddress,
                callbackURL: createDto.callbackURL,
                currency: createDto.currency || 'INR',
                isWhitelisted: createDto.isWhitelisted !== undefined ? createDto.isWhitelisted : true,
                allowedGameCodes: createDto.allowedGameCodes || [],
                passwordHash, // Agent also has password hash (for backward compatibility)
            });
            const savedAgent = await queryRunner.manager.save(agent);

            // Commit transaction
            await queryRunner.commitTransaction();

            // Return agent details
            const dto = new AgentListResponseDto();
            dto.agentId = savedAgent.agentId;
            dto.cert = savedAgent.cert;
            dto.agentIPaddress = savedAgent.agentIPaddress;
            dto.callbackURL = savedAgent.callbackURL;
            dto.isWhitelisted = savedAgent.isWhitelisted;
            dto.currency = savedAgent.currency;
            dto.allowedGameCodes = savedAgent.allowedGameCodes || [];
            dto.createdAt = savedAgent.createdAt.toISOString();
            dto.updatedAt = savedAgent.updatedAt.toISOString();

            return dto;
        } catch (error) {
            // Rollback transaction on error
            await queryRunner.rollbackTransaction();
            this.logger.error(`Failed to create agent: ${error.message}`, error.stack);
            throw error;
        } finally {
            // Release query runner
            await queryRunner.release();
        }
    }
}

