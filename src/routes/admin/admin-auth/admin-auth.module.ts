import { TypeOrmModule } from "@nestjs/typeorm";
import { Module } from "@nestjs/common";

import { Admin } from "../../../entities/admin.entity";
import { Agents, JwtTokenModule } from "@vector-games/game-core";
import { AdminAuthService } from "./admin-auth.service";
import { AdminAuthController } from "./admin-auth.controller";
import { AdminAuthGuard } from "../guards/admin-auth.guard";
import { RolesGuard } from "../guards/roles.guard";
import { AgentAccessGuard } from "../guards/agent-access.guard";

@Module({
    imports: [TypeOrmModule.forFeature([Admin, Agents]), JwtTokenModule],
    controllers: [AdminAuthController],
    providers: [AdminAuthService, AdminAuthGuard, RolesGuard, AgentAccessGuard],
    exports: [AdminAuthService, AdminAuthGuard, RolesGuard, AgentAccessGuard],
})
export class AdminAuthModule { }