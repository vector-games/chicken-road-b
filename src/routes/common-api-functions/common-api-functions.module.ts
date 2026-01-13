import { Module } from '@nestjs/common';
import { AgentsModule, JwtTokenModule, UserModule, AgentAuthGuard } from '@vector-games/game-core';

import { GameConfigModule } from '../../modules/gameConfig/game-config.module';
import { UserSessionModule } from '../../modules/user-session/user-session.module';
import { GameModule } from '../../modules/games/game.module';

import { CommonApiFunctionsController } from './common-api-functions.controller';
import { CommonApiFunctionsService } from './common-api-functions.service';

@Module({
  imports: [AgentsModule, GameConfigModule, UserModule, JwtTokenModule, UserSessionModule, GameModule],
  controllers: [CommonApiFunctionsController],
  providers: [CommonApiFunctionsService, AgentAuthGuard],
  exports: [],
})
export class CommonApiFunctionsModule {}
