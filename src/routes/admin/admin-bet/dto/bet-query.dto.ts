import { ApiProperty } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsOptional, IsNumber, Min, Max, IsString, IsEnum, IsDateString } from "class-validator";
import { BetStatus as BackendBetStatus } from "@vector-games/game-core";
import { Difficulty } from "../../../../entities/bet.entity";

// Frontend-compatible BetStatus enum (uppercase)
export enum BetStatus {
    PENDING = 'PENDING',
    WON = 'WON',
    LOST = 'LOST',
    CANCELLED = 'CANCELLED',
}

export class BetQueryDto {
    @ApiProperty({ required: false, example: 1, description: "Page number" })
    @Type(() => Number)
    @IsOptional()
    @IsNumber()
    @Min(1)
    page?: number;

    @ApiProperty({ required: false, example: 20, description: "Items per page (max 100)" })
    @Type(() => Number)
    @IsOptional()
    @IsNumber()
    @Min(1)
    @Max(100)
    limit?: number;

    @ApiProperty({ required: false, example: "user123", description: "Filter by user ID" })
    @IsOptional()
    @IsString()
    userId?: string;

    @ApiProperty({ required: false, example: "agent001", description: "Filter by agent ID (Super Admin only)" })
    @IsOptional()
    @IsString()
    agentId?: string;

    @ApiProperty({ required: false, enum: BetStatus, description: "Filter by bet status (frontend format)" })
    @IsOptional()
    @IsString()
    status?: string; // Accept string, will be mapped to backend status in service

    @ApiProperty({ required: false, enum: Difficulty, description: "Filter by difficulty" })
    @IsOptional()
    @IsEnum(Difficulty)
    difficulty?: Difficulty;

    @ApiProperty({ required: false, example: "INR", description: "Filter by currency" })
    @IsOptional()
    @IsString()
    currency?: string;

    @ApiProperty({ required: false, example: "SPADE", description: "Filter by platform" })
    @IsOptional()
    @IsString()
    platform?: string;

    @ApiProperty({ required: false, example: "ChickenRoad", description: "Filter by game name/code" })
    @IsOptional()
    @IsString()
    game?: string;

    @ApiProperty({ required: true, example: "2024-01-01T00:00:00Z", description: "Filter from date (ISO string) - Frontend will always provide this" })
    @IsDateString()
    fromDate: string;

    @ApiProperty({ required: true, example: "2024-12-31T23:59:59Z", description: "Filter to date (ISO string) - Frontend will always provide this" })
    @IsDateString()
    toDate: string;
}

