import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";

import { GameService } from "./game.service";
import { Game } from "../../entities/game.entity";

@Module({
    imports: [TypeOrmModule.forFeature([Game])],
    providers: [GameService],
    exports: [GameService], // Export GameService so it can be used by BetModule
})

export class GameModule { }