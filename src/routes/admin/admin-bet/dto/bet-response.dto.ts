import { ApiProperty } from "@nestjs/swagger";
import { Bet, BetStatus as BackendBetStatus } from "@vector-games/game-core";
import { Difficulty } from "../../../../entities/bet.entity";

/**
 * Frontend-compatible Bet response DTO
 * Maps backend Bet entity to frontend Bet interface
 */
export class BetResponseDto {
    @ApiProperty({ description: 'Bet ID' })
    id: string;

    @ApiProperty({ description: 'External platform transaction ID', required: false })
    externalPlatformTxId?: string;

    @ApiProperty({ description: 'User ID' })
    userId: string;

    @ApiProperty({ description: 'Agent ID (same as operatorId)' })
    agentId: string;

    @ApiProperty({ description: 'Operator ID (agent ID)', required: false })
    operatorId?: string;

    @ApiProperty({ description: 'Round ID', required: false })
    roundId?: string;

    @ApiProperty({ description: 'Platform', required: false })
    platform?: string;

    @ApiProperty({ description: 'Game name (mapped from gameCode)', required: false })
    game?: string;

    @ApiProperty({ description: 'Difficulty level', enum: ['EASY', 'MEDIUM', 'HARD', 'DAREDEVIL'] })
    difficulty: string;

    @ApiProperty({ description: 'Bet amount' })
    betAmount: string;

    @ApiProperty({ description: 'Win amount', required: false })
    winAmount?: string;

    @ApiProperty({ description: 'Currency' })
    currency: string;

    @ApiProperty({ 
        description: 'Bet status (mapped to uppercase)', 
        enum: ['PENDING', 'WON', 'LOST', 'CANCELLED', 'PLACED', 'PENDING_SETTLEMENT', 'REFUNDED', 'SETTLEMENT_FAILED'] 
    })
    status: string;

    @ApiProperty({ description: 'Bet placed date (ISO string)' })
    betPlacedAt: string;

    @ApiProperty({ description: 'Settled date (ISO string)', required: false })
    settledAt?: string;

    @ApiProperty({ description: 'Final coefficient', required: false })
    finalCoeff?: string;

    /**
     * Map backend Bet entity to frontend-compatible format
     * @param bet - Bet entity
     * @param platform - Platform from games table (optional)
     */
    static fromEntity(bet: Bet, platform?: string): BetResponseDto {
        const dto = new BetResponseDto();
        dto.id = bet.id;
        dto.externalPlatformTxId = bet.externalPlatformTxId;
        dto.userId = bet.userId;
        dto.agentId = bet.operatorId; // Map operatorId to agentId
        dto.operatorId = bet.operatorId;
        dto.roundId = bet.roundId;
        dto.platform = platform; // Platform from games table
        dto.game = bet.gameCode; // Map gameCode to game
        dto.difficulty = bet.gameMetadata?.difficulty || '';
        dto.betAmount = bet.betAmount;
        dto.winAmount = bet.winAmount;
        dto.currency = bet.currency;
        dto.finalCoeff = bet.finalCoeff;
        
        // Map backend status to frontend status format
        // Backend: 'won', 'lost', 'placed', 'pending_settlement', etc.
        // Frontend: 'WON', 'LOST', 'PENDING', 'CANCELLED', etc.
        dto.status = this.mapStatus(bet.status);
        
        dto.betPlacedAt = bet.betPlacedAt ? bet.betPlacedAt.toISOString() : new Date().toISOString();
        dto.settledAt = bet.settledAt ? bet.settledAt.toISOString() : undefined;
        
        return dto;
    }

    /**
     * Map backend BetStatus enum to frontend-compatible status string
     * Returns all statuses as-is (uppercase) for proper display in UI
     */
    private static mapStatus(backendStatus: BackendBetStatus): string {
        const statusMap: Record<BackendBetStatus, string> = {
            [BackendBetStatus.PLACED]: 'PLACED',
            [BackendBetStatus.PENDING_SETTLEMENT]: 'PENDING_SETTLEMENT',
            [BackendBetStatus.WON]: 'WON',
            [BackendBetStatus.LOST]: 'LOST',
            [BackendBetStatus.CANCELLED]: 'CANCELLED',
            [BackendBetStatus.REFUNDED]: 'REFUNDED',
            [BackendBetStatus.SETTLEMENT_FAILED]: 'SETTLEMENT_FAILED',
        };
        
        return statusMap[backendStatus] || backendStatus.toUpperCase();
    }
}

