import { Logger, Module, OnModuleInit, forwardRef } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule, TypeOrmModuleOptions } from '@nestjs/typeorm';

import appConfig from './config/app.config';
import databaseConfig from './config/database.config';
import redisConfig from './config/redis.config';
import jwtConfig from './config/jwt.config';
import { DEFAULTS } from './config/defaults.config';

import { UserModule, AgentsModule, WalletAuditModule, WalletRetryModule, JwtTokenModule, WalletModule } from '@vector-games/game-core';

import { User, Agents, Bet, WalletAudit, WalletRetryJob } from '@vector-games/game-core';
import { GameConfig } from './entities/game-config.entity';

import { BetCleanupSchedulerModule } from './modules/bet-cleanup/bet-cleanup-scheduler.module';
import { HazardModule } from './modules/hazard/hazard.module';
import { CommonApiFunctionsModule } from './routes/common-api-functions/common-api-functions.module';
import { GameApiRoutesModule } from './routes/game-api-routes/game-api-routes.module';
import { GamePlayModule } from './routes/gamePlay/game-play.module';
import { HealthController } from './routes/extra/health.controller';
import { Game } from './entities/game.entity';
import { BetConfigModule } from './modules/bet-config/bet-config.module';
import { WalletConfigModule } from './modules/wallet-config/wallet-config.module';
import { AppController } from './app.controller';
import { Admin } from './entities/admin.entity';
import { AdminModule } from './routes/admin/admin.module';
import { RefundSchedulerModule } from './modules/refund-scheduler/refund-scheduler.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env'],
      load: [appConfig, databaseConfig, redisConfig, jwtConfig],
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (cfg: ConfigService): TypeOrmModuleOptions => {
        interface DatabaseConfig {
          host: string;
          port: number;
          username: string;
          password: string;
          database: string;
          synchronize: boolean;
        }
        const dbConfig = cfg.get<DatabaseConfig>('database') || {
          host: process.env.DB_HOST || DEFAULTS.DATABASE.DEFAULT_HOST,
          port: parseInt(process.env.DB_PORT || String(DEFAULTS.DATABASE.DEFAULT_PORT), 10),
          username: process.env.DB_USERNAME || DEFAULTS.DATABASE.DEFAULT_USERNAME,
          password: process.env.DB_PASSWORD || DEFAULTS.DATABASE.DEFAULT_PASSWORD,
          database: process.env.DB_DATABASE || DEFAULTS.DATABASE.DEFAULT_DATABASE,
          synchronize:
            process.env.DB_SYNCHRONIZE === undefined
              ? DEFAULTS.DATABASE.DEFAULT_SYNCHRONIZE
              : process.env.DB_SYNCHRONIZE === 'true',
        };
        const cfgObj: TypeOrmModuleOptions = {
          type: 'mysql',
          host: dbConfig.host,
          port: dbConfig.port,
          username: dbConfig.username,
          password: dbConfig.password,
          database: dbConfig.database,
          synchronize: dbConfig.synchronize,
          autoLoadEntities: true,
          entities: [User, Agents, GameConfig, Bet, WalletAudit, WalletRetryJob, Game, Admin],
          extra: {
            // Valid MySQL2 connection pool options for TypeORM
            connectionLimit: parseInt(
              process.env.DB_CONNECTION_LIMIT || '30',
              10,
            )
          },
        };
        Logger.log(
          `Database config -> host=${cfgObj.host} port=${cfgObj.port} db=${cfgObj.database} sync=${cfgObj.synchronize}`,
        );
        return cfgObj;
      },
    }),
    // Register local entities only - package modules will register their own entities
    TypeOrmModule.forFeature([GameConfig, Game, Admin]),
    // Package modules - they register their own entities via TypeOrmModule.forFeature()
    // Using forwardRef to ensure TypeORM root is fully initialized before these modules
    forwardRef(() => UserModule),
    forwardRef(() => AgentsModule),
    forwardRef(() => BetConfigModule), // Configured BetModule with GameService validation
    forwardRef(() => WalletConfigModule), // Configured WalletModule with GameService as WalletApiAdapter
    forwardRef(() => WalletAuditModule),
    forwardRef(() => WalletRetryModule),
    JwtTokenModule.forRoot({
      secret: process.env.JWT_SECRET || DEFAULTS.JWT.DEFAULT_SECRET,
      expiresIn: '24h',
      genericExpiresIn: '1h',
    }),
    HazardModule,
    BetCleanupSchedulerModule,
    RefundSchedulerModule,
    CommonApiFunctionsModule,
    GameApiRoutesModule,
    GamePlayModule,
    AdminModule,
  ],
  controllers: [HealthController, AppController],
  providers: [],
})
export class AppModule implements OnModuleInit {
  private readonly logger = new Logger(AppModule.name);

  async onModuleInit() {
    // This ensures TypeORM is fully initialized before any feature modules use repositories
    this.logger.log('AppModule initialized - TypeORM DataSource should be ready');
  }
}
