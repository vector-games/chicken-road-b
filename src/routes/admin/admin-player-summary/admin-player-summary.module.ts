import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { Bet, JwtTokenModule } from "@vector-games/game-core";
import { Game } from "../../../entities/game.entity";
import { AdminPlayerSummaryService } from "./admin-player-summary.service";
import { AdminPlayerSummaryController } from "./admin-player-summary.controller";
import { AdminAuthGuard } from "../guards/admin-auth.guard";
import { RolesGuard } from "../guards/roles.guard";

@Module({
    imports: [TypeOrmModule.forFeature([Bet, Game]), JwtTokenModule],
    controllers: [AdminPlayerSummaryController],
    providers: [AdminPlayerSummaryService, AdminAuthGuard, RolesGuard],
    exports: [AdminPlayerSummaryService],
})
export class AdminPlayerSummaryModule {}

