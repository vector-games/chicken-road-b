import { ApiProperty } from "@nestjs/swagger";
import { IsNotEmpty, IsString, MinLength } from "class-validator";

export class AgentProfileResponseDto {
    @ApiProperty({ description: 'Admin ID', example: 'uuid' })
    id: string;

    @ApiProperty({ description: 'Username (Agent ID)', example: 'agent123' })
    username: string;

    @ApiProperty({ description: 'Role', example: 'ADMIN', enum: ['SUPER_ADMIN', 'ADMIN'] })
    role: string;

    @ApiProperty({ description: 'Agent ID', example: 'agent123' })
    agentId: string;

    @ApiProperty({ description: 'Certificate', example: 'cert123' })
    cert: string;

    @ApiProperty({ description: 'Agent IP Address', example: '*' })
    agentIPaddress: string;

    @ApiProperty({ description: 'Callback URL', example: 'https://example.com/callback' })
    callbackURL: string;

    @ApiProperty({ description: 'Is Active (Whitelisted)', example: true })
    isActive: boolean;

    @ApiProperty({ description: 'Currency', example: 'INR' })
    currency: string;

    @ApiProperty({ description: 'Allowed Game Codes', example: ['chicken-road-gold'], type: [String] })
    allowedGameCodes: string[];

    @ApiProperty({ description: 'Created At', example: '2024-01-01T00:00:00.000Z' })
    createdAt: string;

    @ApiProperty({ description: 'Updated At', example: '2024-01-01T00:00:00.000Z' })
    updatedAt: string;
}

export class ChangePasswordDto {
    @ApiProperty({
        description: 'Current password',
        example: 'currentPassword123',
    })
    @IsString()
    @IsNotEmpty()
    currentPassword: string;

    @ApiProperty({
        description: 'New password (minimum 8 characters)',
        example: 'newPassword123',
    })
    @IsString()
    @IsNotEmpty()
    @MinLength(8, { message: 'Password must be at least 8 characters long' })
    newPassword: string;

    @ApiProperty({
        description: 'Confirm new password',
        example: 'newPassword123',
    })
    @IsString()
    @IsNotEmpty()
    confirmPassword: string;
}

