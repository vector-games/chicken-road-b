import { Module } from '@nestjs/common';
import { BetModule } from '@vector-games/game-core';
import { GameModule } from '../games/game.module';
import { GameService } from '../games/game.service';

// Import GAME_VALIDATION_SERVICE from the package's compiled service
// Note: We need to use the same symbol that BetService uses
// Since it's not exported from index, we import from the dist file
import { GAME_VALIDATION_SERVICE } from '@vector-games/game-core/dist/services/bet/bet.service';

/**
 * Module that configures BetModule with GameService as the validation service
 * This enables automatic game validation when placing bets via BetService
 */
@Module({
  imports: [
    GameModule, // Import GameModule to get GameService
    BetModule.forRoot(), // Initialize BetModule
  ],
  providers: [
    {
      provide: GAME_VALIDATION_SERVICE,
      useExisting: GameService, // Use GameService as GameValidationService
    },
  ],
  exports: [BetModule], // Export BetModule so it can be used elsewhere
})
export class BetConfigModule {}
