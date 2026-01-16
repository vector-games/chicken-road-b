import { TypeOrmModule } from "@nestjs/typeorm";
import { Module } from "@nestjs/common";

import { Bet, Agents } from "@vector-games/game-core";
import { Game } from "../../../entities/game.entity";
import { Admin } from "../../../entities/admin.entity";
import { AdminAgentService } from "./admin-agent.service";
import { AdminAgentController } from "./admin-agent.controller";
import { AdminAuthGuard } from "../guards/admin-auth.guard";
import { RolesGuard } from "../guards/roles.guard";

@Module({
    imports: [TypeOrmModule.forFeature([Bet, Game, Agents, Admin])],
    controllers: [AdminAgentController],
    providers: [AdminAgentService, AdminAuthGuard, RolesGuard],
    exports: [AdminAgentService],
})
export class AdminAgentModule {}

