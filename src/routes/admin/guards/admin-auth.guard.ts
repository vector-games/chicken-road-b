import { Injectable, CanActivate, ExecutionContext, UnauthorizedException } from "@nestjs/common";

import { JwtTokenService } from "@vector-games/game-core";
import { AdminTokenPayload } from "../admin-auth/admin-auth.service";

@Injectable()
export class AdminAuthGuard implements CanActivate {
    constructor(private readonly jwtTokenService: JwtTokenService) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const request = context.switchToHttp().getRequest();
        const authHeader = request.headers?.authorization;
        
        if (!authHeader) {
            throw new UnauthorizedException('Authorization header missing');
        }

        const token = authHeader.split(' ')[1];
        if (!token) {
            throw new UnauthorizedException('Token missing');
        }

        try {
            const decoded = await this.jwtTokenService.verifyToken<AdminTokenPayload>(token);
            
            if (!decoded || !decoded.sub || !decoded.username || !decoded.role) {
                throw new UnauthorizedException('Invalid token payload');
            }

            // Attach admin info to request for use in controllers
            request.admin = decoded;
            return true;
        } catch (error) {
            if (error instanceof UnauthorizedException) {
                throw error;
            }
            throw new UnauthorizedException('Invalid or expired token');
        }
    }
}