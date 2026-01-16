import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Bet } from '@vector-games/game-core';
import { BetService } from './bet.service';
import { GameModule } from '../games/game.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Bet]),
    GameModule,
  ],
  providers: [BetService],
  exports: [BetService],
})
export class BetModule {}
