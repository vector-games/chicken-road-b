import { Injectable, Logger, UnauthorizedException, BadRequestException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { JwtTokenService } from '@vector-games/game-core';
import { UserSessionService } from '../../modules/user-session/user-session.service';
import { GameService } from '../../modules/games/game.service';
import { GameConfigService } from '../../modules/gameConfig/game-config.service';
import { HazardSchedulerService } from '../../modules/hazard/hazard-scheduler.service';
import { Difficulty } from '../gamePlay/DTO/bet-payload.dto';
import { AuthLoginDto, AuthLoginResponse } from './DTO/auth-login.dto';
import { OnlineCounterResponse } from './DTO/online-counter.dto';
import { CreateGameDto, CreateGameResponse } from './DTO/create-game.dto';

@Injectable()
export class GameApiRoutesService {
  private readonly logger = new Logger(GameApiRoutesService.name);

  constructor(
    private readonly jwtTokenService: JwtTokenService,
    private readonly userSessionService: UserSessionService,
    private readonly gameService: GameService,
    private readonly gameConfigService: GameConfigService,
    private readonly hazardSchedulerService: HazardSchedulerService,
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async authenticateGame(dto: AuthLoginDto): Promise<AuthLoginResponse> {
    this.logger.log(
      `[authenticateGame] Request received - operator: ${dto.operator}, currency: ${dto.currency}, game_mode: ${dto.game_mode}`,
    );
    // TODO: Validate operator (agent_id) against database
    // For now, just accepting the value

    // Verify the incoming JWT token and extract userId and agentId
    let decoded: any;
    try {
      decoded = await this.jwtTokenService.verifyToken(dto.auth_token);
      this.logger.log(
        `[authenticateGame] Token verified successfully - decoded: ${JSON.stringify(decoded)}`,
      );
    } catch (error) {
      this.logger.warn(
        `[TOKEN_VERIFICATION_FAILED] operator=${dto.operator} reason=${error.message}`,
      );
      throw new UnauthorizedException('Invalid auth token');
    }

    // Extract userId and agentId from the decoded token
    const userId = decoded.sub || decoded.userId;
    const agentId = decoded.agentId || dto.operator;

    if (!userId) {
      this.logger.warn(
        `[authenticateGame] No userId found in token - operator: ${dto.operator}`,
      );
      throw new UnauthorizedException('Invalid token: missing userId');
    }

    // Generate new JWT token with userId, agentId, and operator_id
    const newToken = await this.jwtTokenService.signGenericToken(
      {
        sub: userId,
        agentId: agentId,
        currency: dto.currency,
        game_mode: dto.game_mode,
        timestamp: Date.now(),
      },
    );

    // Add user to logged-in sessions
    // Note: game_mode from DTO is the gameCode
    await this.userSessionService.addSession(userId, agentId, dto.game_mode);

    this.logger.log(
      `[TOKEN_VERIFIED] user=${userId} agent=${agentId} operator=${dto.operator} currency=${dto.currency} gameMode=${dto.game_mode} tokenGenerated=true`,
    );

    // Return response with dummy data as requested
    return {
      success: true,
      result: newToken,
      data: newToken,
      gameConfig: null,
      bonuses: [],
      isLobbyEnabled: false,
      isPromoCodeEnabled: false,
      isSoundEnabled: false,
      isMusicEnabled: false,
    };
  }

  async getOnlineCounter(token: string): Promise<OnlineCounterResponse> {
    this.logger.log(`[getOnlineCounter] Request received`);

    try {
      const decoded = await this.jwtTokenService.verifyToken(token);
      this.logger.log(
        `[getOnlineCounter] Token verified - operator_id: ${decoded['operator_id'] || 'N/A'}`,
      );
    } catch (error) {
      this.logger.warn(
        `[getOnlineCounter] Token verification failed - error: ${error.message}`,
      );
      throw new UnauthorizedException('Invalid or expired token');
    }

    this.logger.log(
      `[getOnlineCounter] SUCCESS - Returning online counter data`,
    );

    const actualLoggedInUsers = await this.userSessionService.getLoggedInUserCount();
    const pumpValue = Math.floor(Math.random() * (15000 - 11000 + 1)) + 11000;
    const total = actualLoggedInUsers + pumpValue;

    this.logger.log(
      `[getOnlineCounter] User count - actual: ${actualLoggedInUsers}, pump: ${pumpValue}, total: ${total}`,
    );

    return {
      "result": {
        "total": total,
        "gameMode": {
          "hamster-run": 321,
          "squid-game": 270,
          "chicken-road-two": 6937,
          "forest-fortune-v1": 161,
          "chicken-royal": 50,
          "chicken-road": 1980,
          "penalty-unlimited": 175,
          "lucky-mines": 43,
          "coinflip": 23,
          "chicken-road-97": 266,
          "diver": 104,
          "twist": 286,
          "tower": 23,
          "chicken-road-zombies": 36,
          "aviafly": 81,
          "chicken-road-two-4ravip": 1,
          "unknown": 4,
          "chicken-road-1xbet": 34,
          "chicken-road-gold": 91,
          "chicken-road-race": 47,
          "wheel": 100,
          "robo-dice": 6,
          "jogo-do-bicho": 6,
          "keno": 6,
          "cricket-road": 25,
          "triple": 17,
          "sugar-daddy": 81,
          "chicken-road-two-v4": 63,
          "fish-road-v1": 17,
          "new-double": 39,
          "bubbles": 10,
          "plinko-aztec": 82,
          "chicken-road-vegas": 90,
          "new-hilo": 10,
          "rabbit-road-inout": 51,
          "stairs": 11,
          "hot-mines": 9,
          "roulette": 25,
          "crash": 24,
          "goblin-tower": 14,
          "chicken-road-v6": 23,
          "plinko": 50,
          "fish-boom": 17,
          "ballonix": 36,
          "chicken-road-two-melbet": 26,
          "limbo": 19,
          "chicken-road-92": 8,
          "twist-topx": 1,
          "joker-poker": 6,
          "cryptos": 5,
          "rock-paper-scissors": 10,
          "chicken-road-two-lucky-star": 6,
          "chicken-road-two-chillbetmx": 0,
          "chicken-road-two-n1bet": 6,
          "chicken-road-two-v2": 12,
          "pengu-sport": 0,
          "plinko-v2": 0,
          "twist-valor": 4,
          "lucky-captain": 2,
          "chicken-road-two-trueluck": 0,
          "rabbit-road": 4,
          "plinko-aztec-v2": 2,
          "chicken-road-two-social": 0,
          "diver-boomerang": 0,
          "chicken-road-two-jeetcity": 0,
          "chicken-road-97-social": 0,
          "twist-v2": 0,
          "twist-v3": 0,
          "twist-new-year": 0,
          "forest-fortune-v1-social": 0,
          "ballonix-social": 0,
          "twist-new-year-v3": 0,
          "penalty-unlimited-social": 0,
          "plinko-aztec-social": 0,
          "hamster-run-social": 0,
          "chicken-road-two-chacha-bet": 0,
          "teenPattyExpress": 0,
          "chicken-road-two-chillbet": 0,
          "twist-new-year-v2": 0,
          "chicken-road-two-v3": 0,
          "chicken-road-easy": 0,
          "diver-fast": 0,
          "joker-poker-social": 0,
          "wheel-social": 0,
          "chicken-road-hard": 0,
          "twist-social": 0,
          "chicken-road-97-easy": 0,
          "chicken-road-97-hard": 0
        }
      }
    }
  }

  async getActiveGames(): Promise<Array<{ gameCode: string; gameName: string; isActive: boolean }>> {
    this.logger.log(`[getActiveGames] Request received`);
    const games = await this.gameService.getActiveGames();
    return games
      .filter(game => game.isActive)
      .map(game => ({
        gameCode: game.gameCode,
        gameName: game.gameName,
        isActive: game.isActive,
      }));
  }

  /**
   * Normalize gameCode for table names (hyphens to underscores)
   */
  private normalizeGameCode(gameCode: string): string {
    return gameCode.toLowerCase().replace(/-/g, '_');
  }

  /**
   * Create a new game with automatic onboarding:
   * 1. Create game in games table
   * 2. Create config table
   * 3. Copy configs from game_config table (default source)
   * 4. Initialize hazards for all difficulties
   */
  async createGameWithOnboarding(dto: CreateGameDto): Promise<CreateGameResponse> {
    this.logger.log(`[createGameWithOnboarding] Creating game: ${dto.gameCode}`);

    const normalizedGameCode = this.normalizeGameCode(dto.gameCode);
    const configTableName = `game_config_${normalizedGameCode}`;
    const sourceConfigTableName = 'game_config';

    try {
      // Step 1: Create game in games table
      this.logger.log(`[createGameWithOnboarding] Step 1: Creating game in games table`);
      const game = await this.gameService.createGame({
        gameCode: dto.gameCode,
        gameName: dto.gameName,
        platform: dto.platform,
        gameType: dto.gameType,
        settleType: dto.settleType,
        isActive: true,
      });
      this.logger.log(`[createGameWithOnboarding] Game created: ${game.id}`);

      // Step 2: Create config table
      this.logger.log(`[createGameWithOnboarding] Step 2: Creating config table: ${configTableName}`);
      const createTableQuery = `
        CREATE TABLE IF NOT EXISTS \`${configTableName}\` (
          id INT AUTO_INCREMENT PRIMARY KEY,
          \`key\` VARCHAR(255) NOT NULL,
          value TEXT,
          updatedAt DATETIME,
          UNIQUE KEY uk_key (\`key\`),
          INDEX idx_key (\`key\`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
      `;
      await this.dataSource.query(createTableQuery);
      this.logger.log(`[createGameWithOnboarding] Config table created: ${configTableName}`);

      this.logger.log(`[createGameWithOnboarding] Step 3: Copying configs from ${sourceConfigTableName}`);
      let configsCopied = 0;
      try {
        const sourceTableExists = await this.dataSource.query(
          `SELECT COUNT(*) as count FROM INFORMATION_SCHEMA.TABLES 
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
          [sourceConfigTableName]
        );

        if (sourceTableExists[0]?.count > 0) {
          const copyQuery = `
            INSERT INTO \`${configTableName}\` (\`key\`, value, updatedAt)
            SELECT \`key\`, value, NOW()
            FROM \`${sourceConfigTableName}\`
            ON DUPLICATE KEY UPDATE value = VALUES(value), updatedAt = NOW();
          `;
          const result = await this.dataSource.query(copyQuery);
          configsCopied = result.affectedRows || 0;
          this.logger.log(`[createGameWithOnboarding] Copied ${configsCopied} configs from ${sourceConfigTableName}`);
        } else {
          this.logger.warn(`[createGameWithOnboarding] Source config table ${sourceConfigTableName} does not exist. Skipping config copy.`);
        }
      } catch (error) {
        this.logger.error(`[createGameWithOnboarding] Error copying configs: ${error.message}`);
      }

      this.logger.log(`[createGameWithOnboarding] Step 4: Initializing hazards for all difficulties`);
      let hazardsInitialized = false;
      try {
        const difficulties = [Difficulty.EASY, Difficulty.MEDIUM, Difficulty.HARD, Difficulty.DAREDEVIL];
        for (const difficulty of difficulties) {
          try {
            await this.hazardSchedulerService.forceInitialize(dto.gameCode, difficulty);
            this.logger.log(`[createGameWithOnboarding] Hazards initialized for ${dto.gameCode} ${difficulty}`);
          } catch (error) {
            this.logger.warn(`[createGameWithOnboarding] Failed to initialize hazards for ${dto.gameCode} ${difficulty}: ${error.message}`);
          }
        }
        hazardsInitialized = true;
        this.logger.log(`[createGameWithOnboarding] Hazards initialization completed for ${dto.gameCode}`);
      } catch (error) {
        this.logger.error(`[createGameWithOnboarding] Error initializing hazards: ${error.message}`);
      }

      this.logger.log(`[createGameWithOnboarding] ✅ Game onboarding completed: ${dto.gameCode}`);

      return {
        success: true,
        message: `Game ${dto.gameCode} created and onboarded successfully`,
        game: {
          id: game.id,
          gameCode: game.gameCode,
          gameName: game.gameName,
          platform: game.platform,
          gameType: game.gameType,
          settleType: game.settleType,
          isActive: game.isActive,
        },
        configTableCreated: true,
        configsCopied,
        hazardsInitialized,
      };
    } catch (error) {
      this.logger.error(`[createGameWithOnboarding] Error creating game: ${error.message}`);
      throw error;
    }
  }
}
