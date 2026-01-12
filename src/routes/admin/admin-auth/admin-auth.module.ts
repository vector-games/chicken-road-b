import { TypeOrmModule } from "@nestjs/typeorm";
import { Module } from "@nestjs/common";

import { Admin } from "../../../entities/admin.entity";
import { Agents } from "../../../entities/agents.entity";
import { AdminAuthService } from "./admin-auth.service";
import { AdminAuthController } from "./admin-auth.controller";
import { JwtTokenModule } from "../../../modules/jwt/jwt-token.module";
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