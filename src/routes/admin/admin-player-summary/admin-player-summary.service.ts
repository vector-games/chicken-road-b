import { Injectable, BadRequestException, ForbiddenException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { Bet, BetStatus } from "@vector-games/game-core";
import { Game } from "../../../entities/game.entity";
import { AdminRole } from "../../../entities/admin.entity";
import { PlayerSummaryQueryDto } from "./dto/player-summary-query.dto";
import { PlayerSummaryResponseDto } from "./dto/player-summary-response.dto";
import { PlayerSummaryTotalsDto } from "./dto/player-summary-totals.dto";
import { PlayerSummaryFilterOptionsDto } from "./dto/player-summary-filter-options.dto";

@Injectable()
export class AdminPlayerSummaryService {
    constructor(
        @InjectRepository(Bet)
        private readonly betRepository: Repository<Bet>,
        @InjectRepository(Game)
        private readonly gameRepository: Repository<Game>,
    ) {}

    async findAll(
        queryDto: PlayerSummaryQueryDto,
        adminRole: string,
        adminAgentId?: string,
    ): Promise<{ players: PlayerSummaryResponseDto[]; pagination: { page: number; limit: number; total: number; totalPages: number } }> {
        const page = queryDto.page || 1;
        const limit = queryDto.limit || 20;
        const skip = (page - 1) * limit;

        const fromDate = queryDto.fromDate ? new Date(queryDto.fromDate) : null;
        const toDate = queryDto.toDate ? new Date(queryDto.toDate) : null;

        if (!fromDate || !toDate) {
            throw new BadRequestException('Date range (fromDate and toDate) is required');
        }

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
                'bet.userId as playerId',
                'COALESCE(game.platform, "UNKNOWN") as platform',
                'bet.gameCode as game',
                'COUNT(DISTINCT bet.id) as betCount',
                'COALESCE(SUM(CASE WHEN bet.status NOT IN (:...excludedStatuses) THEN CAST(bet.betAmount AS DECIMAL(18,3)) ELSE 0 END), 0) as betAmount',
                'COALESCE(SUM(CASE WHEN bet.status NOT IN (:...excludedStatuses) THEN CAST(bet.betAmount AS DECIMAL(18,3)) ELSE 0 END) - SUM(CASE WHEN bet.status = :wonStatus AND bet.winAmount IS NOT NULL AND CAST(bet.winAmount AS DECIMAL(18,3)) > 0 THEN CAST(bet.winAmount AS DECIMAL(18,3)) ELSE 0 END), 0) as playerWinLoss',
            ])
            .where('bet.betPlacedAt >= :fromDate', { fromDate })
            .andWhere('bet.betPlacedAt <= :toDate', { toDate })
            .groupBy('bet.userId')
            .addGroupBy('game.platform')
            .addGroupBy('bet.gameCode')
            .setParameter('excludedStatuses', [BetStatus.REFUNDED, BetStatus.CANCELLED])
            .setParameter('wonStatus', BetStatus.WON);

        // Role-based filtering: Agent Admin can only see their agent's players
        if (adminRole !== AdminRole.SUPER_ADMIN && adminAgentId) {
            queryBuilder.andWhere('bet.operatorId = :adminAgentId', { adminAgentId });
        } else if (queryDto.agentId) {
            // Super Admin can filter by any agentId
            queryBuilder.andWhere('bet.operatorId = :agentId', { agentId: queryDto.agentId });
        }

        // Apply filters
        if (queryDto.playerId) {
            queryBuilder.andWhere('bet.userId = :playerId', { playerId: queryDto.playerId });
        }
        if (queryDto.platform) {
            queryBuilder.andWhere('game.platform = :platform', { platform: queryDto.platform });
        }
        if (queryDto.game) {
            queryBuilder.andWhere('bet.gameCode = :game', { game: queryDto.game });
        }

        // Get total count of groups by executing the same query without pagination
        // We'll get all results and count them (more reliable than CONCAT)
        const countQueryBuilder = this.betRepository
            .createQueryBuilder('bet')
            .leftJoin(Game, 'game', 'bet.gameCode = game.gameCode')
            .select([
                'bet.userId as playerId',
                'COALESCE(game.platform, "UNKNOWN") as platform',
                'bet.gameCode as game',
            ])
            .where('bet.betPlacedAt >= :fromDate', { fromDate })
            .andWhere('bet.betPlacedAt <= :toDate', { toDate })
            .groupBy('bet.userId')
            .addGroupBy('game.platform')
            .addGroupBy('bet.gameCode')
            .setParameter('excludedStatuses', [BetStatus.REFUNDED, BetStatus.CANCELLED])
            .setParameter('wonStatus', BetStatus.WON);

        // Role-based filtering
        if (adminRole !== AdminRole.SUPER_ADMIN && adminAgentId) {
            countQueryBuilder.andWhere('bet.operatorId = :adminAgentId', { adminAgentId });
        } else if (queryDto.agentId) {
            countQueryBuilder.andWhere('bet.operatorId = :agentId', { agentId: queryDto.agentId });
        }

        // Apply filters
        if (queryDto.playerId) {
            countQueryBuilder.andWhere('bet.userId = :playerId', { playerId: queryDto.playerId });
        }
        if (queryDto.platform) {
            countQueryBuilder.andWhere('game.platform = :platform', { platform: queryDto.platform });
        }
        if (queryDto.game) {
            countQueryBuilder.andWhere('bet.gameCode = :game', { game: queryDto.game });
        }

        const countResults = await countQueryBuilder.getRawMany();
        const total = countResults.length;

        // Apply pagination
        queryBuilder.skip(skip).limit(limit);

        // Execute query
        const rawResults = await queryBuilder.getRawMany();

        // Transform results to DTOs
        const players: PlayerSummaryResponseDto[] = rawResults.map((row) => {
            const betAmount = parseFloat(row.betAmount || '0');
            const playerWinLoss = parseFloat(row.playerWinLoss || '0');

            const dto = new PlayerSummaryResponseDto();
            dto.playerId = row.playerId;
            dto.platform = row.platform || 'UNKNOWN';
            dto.game = row.game;
            dto.betCount = parseInt(row.betCount || '0', 10);
            dto.betAmount = betAmount.toFixed(2);
            dto.playerWinLoss = playerWinLoss.toFixed(2);
            dto.totalWinLoss = playerWinLoss.toFixed(2); // Same as playerWinLoss (adjustments not applied at player level)
            return dto;
        });

        return {
            players,
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit),
            },
        };
    }

    async getTotals(
        queryDto: PlayerSummaryQueryDto,
        adminRole: string,
        adminAgentId?: string,
    ): Promise<PlayerSummaryTotalsDto> {
        const fromDate = queryDto.fromDate ? new Date(queryDto.fromDate) : null;
        const toDate = queryDto.toDate ? new Date(queryDto.toDate) : null;

        if (!fromDate || !toDate) {
            throw new BadRequestException('Date range (fromDate and toDate) is required');
        }

        fromDate.setHours(0, 0, 0, 0);
        toDate.setHours(23, 59, 59, 999);

        if (fromDate > toDate) {
            throw new BadRequestException('fromDate must be less than or equal to toDate');
        }

        const queryBuilder = this.betRepository.createQueryBuilder('bet')
            .leftJoin(Game, 'game', 'bet.gameCode = game.gameCode')
            .select([
                'COUNT(DISTINCT bet.userId) as totalPlayers',
                'COUNT(DISTINCT bet.id) as totalBetCount',
                'COALESCE(SUM(CASE WHEN bet.status NOT IN (:...excludedStatuses) THEN CAST(bet.betAmount AS DECIMAL(18,3)) ELSE 0 END), 0) as totalBetAmount',
                'COALESCE(SUM(CASE WHEN bet.status = :wonStatus AND bet.winAmount IS NOT NULL AND CAST(bet.winAmount AS DECIMAL(18,3)) > 0 THEN CAST(bet.winAmount AS DECIMAL(18,3)) ELSE 0 END), 0) as totalWinAmount',
            ])
            .where('bet.betPlacedAt >= :fromDate', { fromDate })
            .andWhere('bet.betPlacedAt <= :toDate', { toDate })
            .setParameter('excludedStatuses', [BetStatus.REFUNDED, BetStatus.CANCELLED])
            .setParameter('wonStatus', BetStatus.WON);

        // Role-based filtering
        if (adminRole !== AdminRole.SUPER_ADMIN && adminAgentId) {
            queryBuilder.andWhere('bet.operatorId = :adminAgentId', { adminAgentId });
        } else if (queryDto.agentId) {
            queryBuilder.andWhere('bet.operatorId = :agentId', { agentId: queryDto.agentId });
        }

        // Apply filters
        if (queryDto.playerId) {
            queryBuilder.andWhere('bet.userId = :playerId', { playerId: queryDto.playerId });
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
        const totalPlayerWinLoss = (totalBetAmount - totalWinAmount); // Company perspective: positive = profit, negative = players won

        const totals = new PlayerSummaryTotalsDto();
        totals.totalPlayers = parseInt(result?.totalPlayers || '0', 10);
        totals.totalBetCount = parseInt(result?.totalBetCount || '0', 10);
        totals.totalBetAmount = totalBetAmount.toFixed(2);
        totals.totalPlayerWinLoss = totalPlayerWinLoss.toFixed(2);
        totals.totalWinLoss = totalPlayerWinLoss.toFixed(2); // Same as totalPlayerWinLoss

        return totals;
    }

    /**
     * Get distinct filter options for player summary
     * Returns distinct values for games, platforms, and agentIds
     */
    async getFilterOptions(
        adminRole: string,
        adminAgentId?: string,
    ): Promise<PlayerSummaryFilterOptionsDto> {
        // Get distinct game codes from bets
        const gameQuery = this.betRepository.createQueryBuilder('bet')
            .select('DISTINCT bet.gameCode', 'gameCode')
            .where('bet.gameCode IS NOT NULL')
            .andWhere('bet.gameCode != ""');
        
        // Role-based filtering
        if (adminRole !== AdminRole.SUPER_ADMIN && adminAgentId) {
            gameQuery.andWhere('bet.operatorId = :adminAgentId', { adminAgentId });
        }
        
        const gameResults = await gameQuery.getRawMany();
        const games = gameResults.map((r) => r.gameCode).filter(Boolean).sort();

        // Get distinct platforms from games table (only for games that have bets)
        const platformQuery = this.betRepository.createQueryBuilder('bet')
            .leftJoin(Game, 'game', 'game.gameCode = bet.gameCode AND game.isActive = 1')
            .select('DISTINCT game.platform', 'platform')
            .where('game.platform IS NOT NULL')
            .andWhere('game.platform != ""');
        
        // Role-based filtering
        if (adminRole !== AdminRole.SUPER_ADMIN && adminAgentId) {
            platformQuery.andWhere('bet.operatorId = :adminAgentId', { adminAgentId });
        }
        
        const platformResults = await platformQuery.getRawMany();
        const platforms = platformResults.map((r) => r.platform).filter(Boolean).sort();

        // Get distinct agent IDs (only for Super Admin)
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
}

