import { ConflictException, Injectable, UnauthorizedException, BadRequestException, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import * as bcrypt from "bcrypt";

import { JwtTokenService } from "../../../modules/jwt/jwt-token.service";

import { Admin, AdminRole } from "../../../entities/admin.entity";
import { Agents } from "../../../entities/agents.entity";
import { LoginDto, LoginResponseDto, RefreshTokenDto, RefreshTokenResponseDto, AdminInfoDto, CreateAdminDto } from "./dto/login.dto";
import { AgentProfileResponseDto, ChangePasswordDto } from "./dto/profile.dto";

export interface AdminTokenPayload {
    sub: string;
    username: string;
    role: string;
    agentId?: string;
    iat?: number;
    exp?: number;
}

@Injectable()
export class AdminAuthService {
    constructor(
        @InjectRepository(Admin)
        private readonly adminRepository: Repository<Admin>,
        @InjectRepository(Agents)
        private readonly agentsRepository: Repository<Agents>,
        private readonly jwtTokenService: JwtTokenService,
    ) { }

    async login(loginDto: LoginDto): Promise<LoginResponseDto> {
        const admin = await this.adminRepository.findOne({ where: { username: loginDto.username } });
        if (!admin) {
            throw new UnauthorizedException('Invalid username or password');
        }
        const isPasswordValid = await bcrypt.compare(loginDto.password, admin.passwordHash);
        if (!isPasswordValid) {
            throw new UnauthorizedException('Invalid username or password');
        }
        
        // For AGENT_ADMIN, agentId = username
        const agentId = admin.role === 'SUPER_ADMIN' ? null : admin.username;
        
        // Generate tokens with role in payload
        const accessTokenPayload = {
            sub: admin.id,
            username: admin.username,
            role: admin.role,
            agentId: agentId,
        };
        const refreshTokenPayload = {
            ...accessTokenPayload,
        };
        
        const accessToken = await this.jwtTokenService.signGenericToken(accessTokenPayload);
        const refreshToken = await this.jwtTokenService.signGenericToken(refreshTokenPayload, 60 * 60 * 24 * 30);
        
        return {
            accessToken: accessToken,
            refreshToken: refreshToken,
            admin: {
                id: admin.id,
                username: admin.username,
                role: admin.role,
                agentId: agentId || '',
            },
        };
    }

    async refreshToken(refreshTokenDto: RefreshTokenDto): Promise<RefreshTokenResponseDto> {
        try {
            const decoded = await this.jwtTokenService.verifyToken<AdminTokenPayload>(refreshTokenDto.refreshToken);
            
            // Verify the token has required fields
            if (!decoded.sub || !decoded.username || !decoded.role) {
                throw new UnauthorizedException('Invalid refresh token');
            }

            // Generate new tokens
            const accessTokenPayload = {
                sub: decoded.sub,
                username: decoded.username,
                role: decoded.role,
                agentId: decoded.agentId,
            };
            const refreshTokenPayload = {
                ...accessTokenPayload,
            };

            const accessToken = await this.jwtTokenService.signGenericToken(accessTokenPayload);
            const refreshToken = await this.jwtTokenService.signGenericToken(refreshTokenPayload, 60 * 60 * 24 * 30);

            return {
                accessToken,
                refreshToken,
            };
        } catch (error) {
            throw new UnauthorizedException('Invalid or expired refresh token');
        }
    }

    async getAdminProfile(adminPayload: AdminTokenPayload): Promise<AdminInfoDto> {
        const admin = await this.adminRepository.findOne({ where: { id: adminPayload.sub } });
        if (!admin) {
            throw new UnauthorizedException('Admin not found');
        }

        const agentId = admin.role === 'SUPER_ADMIN' ? null : admin.username;

        return {
            id: admin.id,
            username: admin.username,
            role: admin.role,
            agentId: agentId || '',
        };
    }

    async signup(signupDto: CreateAdminDto): Promise<any> {
        const admin = await this.adminRepository.findOne({ where: { username: signupDto.username } });
        if (admin) {
            throw new ConflictException('Admin already exists');
        }
        const newAdmin = this.adminRepository.create({
            username: signupDto.username,
            passwordHash: await bcrypt.hash(signupDto.password, 10),
            role: AdminRole.ADMIN,
        });
        await this.adminRepository.save(newAdmin);
        return {
            id: newAdmin.id,
            username: newAdmin.username,
            role: newAdmin.role,
        };
    }

    /**
     * Get agent profile with full details (Agent Admin only)
     */
    async getAgentProfile(adminPayload: AdminTokenPayload): Promise<AgentProfileResponseDto> {
        // Only allow Agent Admins (not Super Admins)
        if (adminPayload.role === AdminRole.SUPER_ADMIN) {
            throw new UnauthorizedException('This endpoint is only available for Agent Admins');
        }

        const admin = await this.adminRepository.findOne({ where: { id: adminPayload.sub } });
        if (!admin) {
            throw new NotFoundException('Admin not found');
        }

        // Agent ID is the username for Agent Admins
        const agentId = admin.username;
        const agent = await this.agentsRepository.findOne({ where: { agentId } });
        if (!agent) {
            throw new NotFoundException('Agent not found');
        }

        const dto = new AgentProfileResponseDto();
        dto.id = admin.id;
        dto.username = admin.username;
        dto.role = admin.role;
        dto.agentId = agentId;
        dto.cert = agent.cert;
        dto.agentIPaddress = agent.agentIPaddress;
        dto.callbackURL = agent.callbackURL;
        dto.isActive = agent.isWhitelisted;
        dto.currency = agent.currency || 'INR';
        dto.allowedGameCodes = agent.allowedGameCodes || [];
        dto.createdAt = agent.createdAt.toISOString();
        dto.updatedAt = agent.updatedAt.toISOString();

        return dto;
    }

    /**
     * Change password for Agent Admin
     */
    async changePassword(adminPayload: AdminTokenPayload, changePasswordDto: ChangePasswordDto): Promise<{ success: boolean; message: string }> {
        // Only allow Agent Admins (not Super Admins)
        if (adminPayload.role === AdminRole.SUPER_ADMIN) {
            throw new UnauthorizedException('This endpoint is only available for Agent Admins');
        }

        // Validate new password matches confirm password
        if (changePasswordDto.newPassword !== changePasswordDto.confirmPassword) {
            throw new BadRequestException('New password and confirm password do not match');
        }

        const admin = await this.adminRepository.findOne({ where: { id: adminPayload.sub } });
        if (!admin) {
            throw new NotFoundException('Admin not found');
        }

        // Verify current password
        const isCurrentPasswordValid = await bcrypt.compare(changePasswordDto.currentPassword, admin.passwordHash);
        if (!isCurrentPasswordValid) {
            throw new UnauthorizedException('Current password is incorrect');
        }

        // Hash new password and update
        const newPasswordHash = await bcrypt.hash(changePasswordDto.newPassword, 10);
        admin.passwordHash = newPasswordHash;
        await this.adminRepository.save(admin);

        return {
            success: true,
            message: 'Password changed successfully',
        };
    }
}
