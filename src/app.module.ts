import { Logger, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule, TypeOrmModuleOptions } from '@nestjs/typeorm';

import appConfig from './config/app.config';
import databaseConfig from './config/database.config';
import redisConfig from './config/redis.config';
import jwtConfig from './config/jwt.config';

import { UserModule, AgentsModule, WalletAuditModule, WalletRetryModule, JwtTokenModule } from '@vector-games/game-core';

import { User, Agents, Bet, WalletAudit, WalletRetryJob } from '@vector-games/game-core';
import { GameConfig } from './entities/game-config.entity';

import { BetCleanupSchedulerModule } from './modules/bet-cleanup/bet-cleanup-scheduler.module';
import { HazardModule } from './modules/hazard/hazard.module';
import { CommonApiFunctionsModule } from './routes/common-api-functions/common-api-functions.module';
import { GameApiRoutesModule } from './routes/game-api-routes/game-api-routes.module';
import { GamePlayModule } from './routes/gamePlay/game-play.module';
import { SingleWalletFunctionsModule } from './routes/single-wallet-functions/single-wallet-functions.module';
import { HealthController } from './routes/extra/health.controller';
import { Game } from './entities/game.entity';
import { BetConfigModule } from './modules/bet-config/bet-config.module';
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
        const dbConfig = cfg.get<DatabaseConfig>('database');
        const cfgObj: TypeOrmModuleOptions = {
          type: 'mysql',
          host: dbConfig?.host,
          port: dbConfig?.port,
          username: dbConfig?.username,
          password: dbConfig?.password,
          database: dbConfig?.database,
          synchronize: dbConfig?.synchronize,
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
    TypeOrmModule.forFeature([User, GameConfig, Agents, Game]),
    UserModule,
    AgentsModule,
    BetConfigModule, // Configured BetModule with GameService validation
    WalletAuditModule,
    WalletRetryModule,
    JwtTokenModule.forRoot({
      secret: process.env.JWT_SECRET || '',
      expiresIn: '24h',
      genericExpiresIn: '1h',
    }),
    HazardModule,
    BetCleanupSchedulerModule,
    RefundSchedulerModule,
    CommonApiFunctionsModule,
    GameApiRoutesModule,
    GamePlayModule,
    SingleWalletFunctionsModule,
    AdminModule,
  ],
  controllers: [HealthController, AppController],
  providers: [],
})
export class AppModule { }
