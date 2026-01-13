import { Game } from "../../entities/game.entity";
import { Injectable, NotFoundException, ConflictException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { GameValidationService, WalletApiAdapter } from "@vector-games/game-core";

@Injectable()
export class GameService implements GameValidationService, WalletApiAdapter {
    constructor(
        @InjectRepository(Game)
        private readonly gameRepository: Repository<Game>,
    ) { }

    async getGame(gameCode: string): Promise<Game> {
        const game = await this.gameRepository.findOne({ where: { gameCode } })
        if (!game) {
            throw new NotFoundException(`Game with code ${gameCode} not found`)
        }
        return game
    }

    async validateGame(gameCode: string): Promise<void> {
        const game = await this.getGame(gameCode)
        if (!game) {
            throw new NotFoundException(`Game with code ${gameCode} not found`)
        }
        if (!game.isActive) {
            throw new NotFoundException(`Game with code ${gameCode} is not active`)
        }
    }

    async getActiveGames(): Promise<Game[]> {
        const games = await this.gameRepository.find({ where: { isActive: true } })
        return games
    }

    async getGamePayloads(gameCode: string): Promise<{
        gameCode: string;
        gameName: string;
        platform: string;
        gameType: string;
        settleType: string;
    }> {
        const game = await this.getGame(gameCode)
        return {
            gameCode: game.gameCode,
            gameName: game.gameName,
            platform: game.platform,
            gameType: game.gameType,
            settleType: game.settleType,
        }
    }

    async createGame(params: {
        gameCode: string;
        gameName: string;
        platform?: string;
        gameType?: string;
        settleType?: string;
        isActive?: boolean;
    }): Promise<Game> {
        // Check if game already exists
        const existing = await this.gameRepository.findOne({ where: { gameCode: params.gameCode } });
        if (existing) {
            throw new ConflictException(`Game with code ${params.gameCode} already exists`);
        }

        const game = this.gameRepository.create({
            gameCode: params.gameCode,
            gameName: params.gameName,
            platform: params.platform || 'In-out',
            gameType: params.gameType || 'CRASH',
            settleType: params.settleType || 'platformTxId',
            isActive: params.isActive !== undefined ? params.isActive : true,
        });

        return await this.gameRepository.save(game);
    }
}