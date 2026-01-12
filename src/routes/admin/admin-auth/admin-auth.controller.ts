import { Body, Controller, Post, Get, UseGuards, Patch } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from "@nestjs/swagger";
import { AdminAuthService, type AdminTokenPayload } from "./admin-auth.service";
import { AdminAuthGuard } from "../guards/admin-auth.guard";
import { RolesGuard, Roles } from "../guards/roles.guard";
import { CurrentAdmin } from "./decorators/admin-auth.decorator";
import { AdminRole } from "../../../entities/admin.entity";
import { LoginDto, LoginResponseDto, RefreshTokenDto, RefreshTokenResponseDto, AdminInfoDto, CreateAdminDto } from "./dto/login.dto";
import { AgentProfileResponseDto, ChangePasswordDto } from "./dto/profile.dto";

@ApiTags('Admin Auth')
@Controller('admin/api/v1/auth')
export class AdminAuthController {
    constructor(private readonly adminAuthService: AdminAuthService) { }

    @Post('login')
    @ApiOperation({ summary: 'Admin login' })
    @ApiResponse({ status: 200, description: 'Login successful', type: LoginResponseDto })
    @ApiResponse({ status: 401, description: 'Invalid credentials' })
    async login(@Body() loginDto: LoginDto): Promise<LoginResponseDto> {
        return this.adminAuthService.login(loginDto);
    }

    @Post('refresh')
    @ApiOperation({ summary: 'Refresh access token' })
    @ApiResponse({ status: 200, description: 'Token refreshed successfully', type: RefreshTokenResponseDto })
    @ApiResponse({ status: 401, description: 'Invalid or expired refresh token' })
    async refreshToken(@Body() refreshTokenDto: RefreshTokenDto): Promise<RefreshTokenResponseDto> {
        return this.adminAuthService.refreshToken(refreshTokenDto);
    }

    @Post('logout')
    @UseGuards(AdminAuthGuard)
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Admin logout' })
    @ApiResponse({ status: 200, description: 'Logout successful' })
    @ApiResponse({ status: 401, description: 'Unauthorized' })
    async logout(): Promise<{ success: boolean }> {
        // In a more advanced implementation, you could blacklist the token here
        // For now, we just return success - the client should discard the token
        return { success: true };
    }

    @Get('me')
    @UseGuards(AdminAuthGuard)
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Get current admin profile' })
    @ApiResponse({ status: 200, description: 'Admin profile', type: AdminInfoDto })
    @ApiResponse({ status: 401, description: 'Unauthorized' })
    async getProfile(@CurrentAdmin() admin: AdminTokenPayload): Promise<AdminInfoDto> {
        return this.adminAuthService.getAdminProfile(admin);
    }

    @Post('signup')
    @ApiOperation({ summary: 'Signup new admin' })
    @ApiResponse({ status: 200, description: 'Admin signed up successfully', type: AdminInfoDto })
    @ApiResponse({ status: 401, description: 'Unauthorized' })
    async signup(@Body() signupDto: CreateAdminDto): Promise<AdminInfoDto> {
        return this.adminAuthService.signup(signupDto);
    }

    @Get('profile/agent')
    @UseGuards(AdminAuthGuard, RolesGuard)
    @Roles(AdminRole.ADMIN)
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Get agent profile with full details (Agent Admin only)' })
    @ApiResponse({ status: 200, description: 'Agent profile retrieved successfully', type: AgentProfileResponseDto })
    @ApiResponse({ status: 401, description: 'Unauthorized' })
    @ApiResponse({ status: 403, description: 'Forbidden - Agent Admin only' })
    @ApiResponse({ status: 404, description: 'Agent not found' })
    async getAgentProfile(@CurrentAdmin() admin: AdminTokenPayload): Promise<{ status: string; data: AgentProfileResponseDto }> {
        const profile = await this.adminAuthService.getAgentProfile(admin);
        return {
            status: '0000',
            data: profile,
        };
    }

    @Patch('profile/change-password')
    @UseGuards(AdminAuthGuard, RolesGuard)
    @Roles(AdminRole.ADMIN)
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Change password (Agent Admin only)' })
    @ApiResponse({ status: 200, description: 'Password changed successfully' })
    @ApiResponse({ status: 400, description: 'Bad request - validation failed' })
    @ApiResponse({ status: 401, description: 'Unauthorized - incorrect current password' })
    @ApiResponse({ status: 403, description: 'Forbidden - Agent Admin only' })
    async changePassword(
        @CurrentAdmin() admin: AdminTokenPayload,
        @Body() changePasswordDto: ChangePasswordDto,
    ): Promise<{ status: string; message: string }> {
        const result = await this.adminAuthService.changePassword(admin, changePasswordDto);
        return {
            status: '0000',
            message: result.message,
        };
    }
}