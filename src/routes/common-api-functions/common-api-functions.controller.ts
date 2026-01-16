import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { AgentAuthGuard } from '@vector-games/game-core';
import { CommonApiFunctionsService } from './common-api-functions.service';
import { CreateMemberBodyDto } from './DTO/create-member.dto';
import { LoginLaunchGameDto } from './DTO/login-launch-game.dto';
import { LoginMemberDto } from './DTO/login-member.dto';
import { LogoutDto } from './DTO/logout.dto';

@UseGuards(AgentAuthGuard)
@Controller('/wallet')
export class CommonApiFunctionsController {
  constructor(private readonly service: CommonApiFunctionsService) {}

  @Post('createMember')
  async createMember(
    @Body() body: CreateMemberBodyDto,
    @Req() req: Request,
  ): Promise<{ status: string; desc: string }> {
    return this.service.createMember(body);
  }

  @Post('login')
  async login(
    @Body() body: LoginMemberDto,
    @Req() req: Request,
  ): Promise<{ status: string; url?: string; extension: any[] }> {
    const agent = (req as any).agent;
    const ipAddress = (req.headers['x-forwarded-for'] as string)?.split(',')[0] || 
                      (req.headers['x-real-ip'] as string) || 
                      req.socket.remoteAddress;
    return this.service.loginMember(agent, body.userId, body.agentId, ipAddress);
  }

  @Post('doLoginAndLaunchGame')
  async doLoginAndLaunchGame(
    @Body() body: LoginLaunchGameDto,
    @Req() req: Request,
  ): Promise<{
    status: string;
    url?: string;
    extension: any[];
    desc?: string;
  }> {
    const agent = (req as any).agent;
    return this.service.loginAndLaunchGame(agent, {
      userId: body.userId,
      agentId: body.agentId,
      platform: body.platform,
      gameType: body.gameType,
      gameCode: body.gameCode,
    });
  }
  @Post('logout')
  async logout(
    @Body() body: LogoutDto,
    @Req() req: Request,
  ): Promise<{ status: string; logoutUsers: string[]; count: number }> {
    const agent = (req as any).agent;
    return this.service.logoutUsers(agent, body.agentId, body.userIds);
  }
}
