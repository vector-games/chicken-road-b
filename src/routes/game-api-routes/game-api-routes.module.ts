import { Module } from '@nestjs/common';
import { JwtTokenModule } from '@vector-games/game-core';
import { UserSessionModule } from '../../modules/user-session/user-session.module';
import { GameModule } from '../../modules/games/game.module';
import { GameConfigModule } from '../../modules/gameConfig/game-config.module';
import { HazardModule } from '../../modules/hazard/hazard.module';
import { GameApiRoutesController } from './game-api-routes.controller';
import { GameApiRoutesService } from './game-api-routes.service';

@Module({
  imports: [JwtTokenModule, UserSessionModule, GameModule, GameConfigModule, HazardModule],
  controllers: [GameApiRoutesController],
  providers: [GameApiRoutesService],
  exports: [GameApiRoutesService],
})
export class GameApiRoutesModule {}
