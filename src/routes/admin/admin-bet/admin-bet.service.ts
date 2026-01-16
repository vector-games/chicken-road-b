import { Injectable, NotFoundException, ForbiddenException, BadRequestException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository, Between, LessThanOrEqual, MoreThanOrEqual, Like } from "typeorm";
import { Bet, BetStatus } from "@vector-games/game-core";
import { Game } from "../../../entities/game.entity";
import { BetQueryDto } from "./dto/bet-query.dto";
import { BetTotalsDto } from "./dto/bet-totals.dto";
import { BetResponseDto } from "./dto/bet-response.dto";
import { AdminRole } from "../../../entities/admin.entity";

@Injectable()
export class AdminBetService {
    constructor(
        @InjectRepository(Bet)
        private readonly betRepository: Repository<Bet>,
        @InjectRepository(Game)
        private readonly gameRepository: Repository<Game>,
    ) { }


    async findAll(
        queryDto: BetQueryDto,
        adminRole: string,
        adminAgentId?: string,
    ): Promise<{ bets: BetResponseDto[]; pagination: { page: number; limit: number; total: number; totalPages: number } }> {
        const page = queryDto.page || 1;
        const limit = queryDto.limit || 20;
        const skip = (page - 1) * limit;

        // Frontend will always provide date range (defaults to 2 months)
        const fromDate = queryDto.fromDate ? new Date(queryDto.fromDate) : null;
        const toDate = queryDto.toDate ? new Date(queryDto.toDate) : null;

        if (!fromDate || !toDate) {
            throw new BadRequestException('Date range (fromDate and toDate) is required');
        }

        // Set time to include entire date range
        fromDate.setHours(0, 0, 0, 0);
        toDate.setHours(23, 59, 59, 999);

        // Build query with left join to games table to get platform
        const queryBuilder = this.betRepository.createQueryBuilder('bet')
            .leftJoin('games', 'game', 'game.gameCode = bet.gameCode AND game.isActive = 1');

        // Apply date range filter
        queryBuilder.where('bet.betPlacedAt >= :fromDate', { fromDate });
        queryBuilder.andWhere('bet.betPlacedAt <= :toDate', { toDate });

        // Role-based filtering: Agent Admin can only see their agent's bets
        if (adminRole !== AdminRole.SUPER_ADMIN && adminAgentId) {
            queryBuilder.andWhere('bet.operatorId = :adminAgentId', { adminAgentId });
        } else if (queryDto.agentId) {
            // Super Admin can filter by any agentId
            queryBuilder.andWhere('bet.operatorId = :agentId', { agentId: queryDto.agentId });
        }

        // Apply filters
        if (queryDto.userId) {
            queryBuilder.andWhere('bet.userId = :userId', { userId: queryDto.userId });
        }

        if (queryDto.status) {
            // Map frontend status to backend status format
            // Legacy PENDING mapping (for backward compatibility) - maps to multiple backend statuses
            if (queryDto.status === 'PENDING' || queryDto.status === 'pending') {
                queryBuilder.andWhere('bet.status IN (:...pendingStatuses)', {
                    pendingStatuses: [BetStatus.PLACED, BetStatus.PENDING_SETTLEMENT, BetStatus.SETTLEMENT_FAILED],
                });
            } else {
                const backendStatus = this.mapFrontendStatusToBackend(queryDto.status);
                if (backendStatus) {
                    queryBuilder.andWhere('bet.status = :status', { status: backendStatus });
                }
            }
        }

        if (queryDto.difficulty) {
            queryBuilder.andWhere('bet.difficulty = :difficulty', { difficulty: queryDto.difficulty });
        }

        if (queryDto.currency) {
            queryBuilder.andWhere('bet.currency = :currency', { currency: queryDto.currency });
        }

        if (queryDto.game) {
            queryBuilder.andWhere('bet.gameCode = :game', { game: queryDto.game });
        }

        // Platform filter - filter by platform from games table
        if (queryDto.platform) {
            queryBuilder.andWhere('game.platform = :platform', { platform: queryDto.platform });
        }

        // Order by most recent first
        queryBuilder.orderBy('bet.betPlacedAt', 'DESC');

        // Get total count before pagination
        const total = await queryBuilder.getCount();

        // Apply pagination
        queryBuilder.skip(skip).take(limit);

        // Execute query - get bets
        const bets = await queryBuilder.getMany();

        // Get unique game codes from bets to fetch platforms in batch
        const gameCodes = [...new Set(bets.map(bet => bet.gameCode).filter(Boolean))];
        
        // Fetch all games at once for better performance
        const games = gameCodes.length > 0
            ? await this.gameRepository.find({
                where: gameCodes.map(code => ({ gameCode: code, isActive: true })),
                select: ['gameCode', 'platform'],
            })
            : [];

        // Create a map of gameCode -> platform for quick lookup
        const platformMap = new Map(games.map(game => [game.gameCode, game.platform]));

        // Map Bet entities to frontend-compatible DTOs with platform
        const betDtos = bets.map(bet => {
            const platform = platformMap.get(bet.gameCode);
            return BetResponseDto.fromEntity(bet, platform);
        });

        return {
            bets: betDtos,
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit),
            },
        };
    }

    async getTotals(
        queryDto: BetQueryDto,
        adminRole: string,
        adminAgentId?: string,
    ): Promise<BetTotalsDto> {
        // Frontend will always provide date range (defaults to 2 months)
        const fromDate = queryDto.fromDate ? new Date(queryDto.fromDate) : null;
        const toDate = queryDto.toDate ? new Date(queryDto.toDate) : null;

        if (!fromDate || !toDate) {
            throw new BadRequestException('Date range (fromDate and toDate) is required');
        }

        // Set time to include entire date range
        fromDate.setHours(0, 0, 0, 0);
        toDate.setHours(23, 59, 59, 999);

        // Build query with left join to games table
        const queryBuilder = this.betRepository.createQueryBuilder('bet')
            .leftJoin('games', 'game', 'game.gameCode = bet.gameCode AND game.isActive = 1');

        // Apply date range filter
        queryBuilder.where('bet.betPlacedAt >= :fromDate', { fromDate });
        queryBuilder.andWhere('bet.betPlacedAt <= :toDate', { toDate });

        // Role-based filtering: Agent Admin can only see their agent's bets
        if (adminRole !== AdminRole.SUPER_ADMIN && adminAgentId) {
            queryBuilder.andWhere('bet.operatorId = :adminAgentId', { adminAgentId });
        } else if (queryDto.agentId) {
            queryBuilder.andWhere('bet.operatorId = :agentId', { agentId: queryDto.agentId });
        }

        // Apply same filters as findAll
        if (queryDto.userId) {
            queryBuilder.andWhere('bet.userId = :userId', { userId: queryDto.userId });
        }

        if (queryDto.status) {
            // Map frontend status to backend status format
            // Legacy PENDING mapping (for backward compatibility) - maps to multiple backend statuses
            if (queryDto.status === 'PENDING' || queryDto.status === 'pending') {
                queryBuilder.andWhere('bet.status IN (:...pendingStatuses)', {
                    pendingStatuses: [BetStatus.PLACED, BetStatus.PENDING_SETTLEMENT, BetStatus.SETTLEMENT_FAILED],
                });
            } else {
                const backendStatus = this.mapFrontendStatusToBackend(queryDto.status);
                if (backendStatus) {
                    queryBuilder.andWhere('bet.status = :status', { status: backendStatus });
                }
            }
        }

        if (queryDto.difficulty) {
            queryBuilder.andWhere('bet.difficulty = :difficulty', { difficulty: queryDto.difficulty });
        }

        if (queryDto.currency) {
            queryBuilder.andWhere('bet.currency = :currency', { currency: queryDto.currency });
        }

        if (queryDto.game) {
            queryBuilder.andWhere('bet.gameCode = :game', { game: queryDto.game });
        }

        // Platform filter - filter by platform from games table
        if (queryDto.platform) {
            queryBuilder.andWhere('game.platform = :platform', { platform: queryDto.platform });
        }

        // Calculate totals from ALL matching records
        // Note: We exclude REFUNDED and CANCELLED bets from financial calculations
        // as they don't represent actual revenue (money was returned or bet was cancelled)
        // Use COUNT(DISTINCT bet.id) to ensure we count unique bets even with LEFT JOIN
        const result = await queryBuilder
            .select('COUNT(DISTINCT bet.id)', 'totalBets')
            // Total bet amount: Sum of all bet amounts (excluding REFUNDED and CANCELLED)
            .addSelect('COALESCE(SUM(CASE WHEN bet.status NOT IN (:...excludedStatuses) THEN bet.betAmount ELSE 0 END), 0)', 'totalBetAmount')
            // Total win amount: Sum of winAmount for bets that actually won (WON status with winAmount > 0)
            // Handle NULL winAmount properly - only count non-null, positive winAmount values
            // Note: SETTLED status doesn't exist in practice - bets are set to WON or LOST after settlement
            .addSelect('COALESCE(SUM(CASE WHEN bet.status = :wonStatus AND bet.winAmount IS NOT NULL AND CAST(bet.winAmount AS DECIMAL(18,3)) > 0 THEN bet.winAmount ELSE 0 END), 0)', 'totalWinAmount')
            .setParameter('excludedStatuses', [BetStatus.REFUNDED, BetStatus.CANCELLED])
            .setParameter('wonStatus', BetStatus.WON)
            .getRawOne();

        const totalBetAmount = result?.totalBetAmount || '0';
        const totalWinAmount = result?.totalWinAmount || '0';
        // Net Revenue = Total Bet Amount - Total Win Amount
        // This represents the company's profit (what players bet minus what they won)
        const netRevenue = (parseFloat(totalBetAmount) - parseFloat(totalWinAmount)).toFixed(2);

        return {
            totalBets: parseInt(result?.totalBets || '0', 10),
            totalBetAmount: parseFloat(totalBetAmount).toFixed(2),
            totalWinAmount: parseFloat(totalWinAmount).toFixed(2),
            netRevenue,
        };
    }

    async findOne(
        betId: string,
        adminRole: string,
        adminAgentId?: string,
    ): Promise<BetResponseDto> {
        const bet = await this.betRepository.findOne({ where: { id: betId } });

        if (!bet) {
            throw new NotFoundException(`Bet with ID ${betId} not found`);
        }

        // Role-based access: Agent Admin can only access their agent's bets
        if (adminRole !== AdminRole.SUPER_ADMIN && adminAgentId) {
            if (bet.operatorId !== adminAgentId) {
                throw new ForbiddenException('Access denied: Cannot access other agent\'s bets');
            }
        }

        // Get platform from games table
        const game = await this.gameRepository.findOne({
            where: { gameCode: bet.gameCode, isActive: true },
            select: ['platform'],
        });

        // Map to frontend-compatible DTO
        return BetResponseDto.fromEntity(bet, game?.platform);
    }

    /**
     * Get distinct filter options (games, currencies, platforms, agentIds)
     * Respects role-based access (Agent Admin only sees their agent's data)
     */
    async getFilterOptions(
        adminRole: string,
        adminAgentId?: string,
    ): Promise<{ games: string[]; currencies: string[]; platforms: string[]; agentIds?: string[] }> {
        // Base query builder with role-based filtering
        const baseQuery = this.betRepository.createQueryBuilder('bet');
        if (adminRole !== AdminRole.SUPER_ADMIN && adminAgentId) {
            baseQuery.where('bet.operatorId = :adminAgentId', { adminAgentId });
        }

        // Get distinct game codes
        const gameQuery = this.betRepository.createQueryBuilder('bet');
        if (adminRole !== AdminRole.SUPER_ADMIN && adminAgentId) {
            gameQuery.where('bet.operatorId = :adminAgentId', { adminAgentId });
        }
        const gameResults = await gameQuery
            .select('DISTINCT bet.gameCode', 'gameCode')
            .where('bet.gameCode IS NOT NULL')
            .andWhere('bet.gameCode != ""')
            .getRawMany();
        const games = gameResults.map((r) => r.gameCode).filter(Boolean).sort();

        // Get distinct currencies
        const currencyQuery = this.betRepository.createQueryBuilder('bet');
        if (adminRole !== AdminRole.SUPER_ADMIN && adminAgentId) {
            currencyQuery.where('bet.operatorId = :adminAgentId', { adminAgentId });
        }
        const currencyResults = await currencyQuery
            .select('DISTINCT bet.currency', 'currency')
            .where('bet.currency IS NOT NULL')
            .andWhere('bet.currency != ""')
            .getRawMany();
        const currencies = currencyResults.map((r) => r.currency).filter(Boolean).sort();

        // Get distinct platforms from games table (only for games that have bets)
        const platformQuery = this.betRepository.createQueryBuilder('bet')
            .leftJoin('games', 'game', 'game.gameCode = bet.gameCode AND game.isActive = 1')
            .select('DISTINCT game.platform', 'platform');
        
        // Apply role-based filtering first
        if (adminRole !== AdminRole.SUPER_ADMIN && adminAgentId) {
            platformQuery.where('bet.operatorId = :adminAgentId', { adminAgentId });
            platformQuery.andWhere('game.platform IS NOT NULL');
            platformQuery.andWhere('game.platform != ""');
        } else {
            platformQuery.where('game.platform IS NOT NULL');
            platformQuery.andWhere('game.platform != ""');
        }
        
        const platformResults = await platformQuery.getRawMany();
        const platforms = platformResults.map((r) => r.platform).filter(Boolean).sort();

        // Get distinct agent IDs (only for Super Admin)
        let agentIds: string[] | undefined;
        if (adminRole === AdminRole.SUPER_ADMIN) {
            const agentQuery = this.betRepository.createQueryBuilder('bet');
            const agentResults = await agentQuery
                .select('DISTINCT bet.operatorId', 'operatorId')
                .where('bet.operatorId IS NOT NULL')
                .andWhere('bet.operatorId != ""')
                .getRawMany();
            agentIds = agentResults.map((r) => r.operatorId).filter(Boolean).sort();
        }

        return {
            games,
            currencies,
            platforms,
            agentIds,
        };
    }

    /**
     * Map frontend status string to backend BetStatus enum
     * Frontend now uses all statuses, so we map them directly
     */
    private mapFrontendStatusToBackend(frontendStatus: string): BetStatus | null {
        const statusMap: Record<string, BetStatus> = {
            // Uppercase frontend formats
            'PLACED': BetStatus.PLACED,
            'PENDING_SETTLEMENT': BetStatus.PENDING_SETTLEMENT,
            'WON': BetStatus.WON,
            'LOST': BetStatus.LOST,
            'CANCELLED': BetStatus.CANCELLED,
            'REFUNDED': BetStatus.REFUNDED,
            'SETTLEMENT_FAILED': BetStatus.SETTLEMENT_FAILED,
            // Lowercase backend formats (for backward compatibility)
            'placed': BetStatus.PLACED,
            'pending_settlement': BetStatus.PENDING_SETTLEMENT,
            'won': BetStatus.WON,
            'lost': BetStatus.LOST,
            'cancelled': BetStatus.CANCELLED,
            'refunded': BetStatus.REFUNDED,
            'settlement_failed': BetStatus.SETTLEMENT_FAILED,
            // Legacy PENDING mapping (for backward compatibility)
            'PENDING': BetStatus.PENDING_SETTLEMENT,
            'pending': BetStatus.PENDING_SETTLEMENT,
        };
        
        return statusMap[frontendStatus] || null;
    }
}

