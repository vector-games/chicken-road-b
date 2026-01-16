import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Server } from 'socket.io';
import { LAST_WIN_DATA, LastWinData } from './last-win.constants';

@Injectable()
export class LastWinBroadcasterService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LastWinBroadcasterService.name);
  private intervalId: NodeJS.Timeout | null = null;
  private server: Server | null = null;

  setServer(server: Server) {
    this.server = server;
  }

  onModuleInit() {
    this.logger.log('LastWinBroadcasterService initialized');
  }

  onModuleDestroy() {
    this.stopBroadcasting();
  }

  startBroadcasting(server: Server) {
    if (this.intervalId) {
      this.logger.warn('Broadcasting already started');
      return;
    }

    this.server = server;
    this.logger.log('Starting last-win broadcasting (every 5 seconds)');

    // Broadcast immediately on start
    this.broadcastNext();

    // Then broadcast every 5 seconds
    this.intervalId = setInterval(() => {
      this.broadcastNext();
    }, 4000);
  }

  stopBroadcasting() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      this.logger.log('Stopped last-win broadcasting');
    }
  }

  private broadcastNext() {
    if (!this.server) {
      this.logger.warn('Server not set, cannot broadcast');
      return;
    }

    // Pick a random item from the array
    const randomIndex = Math.floor(Math.random() * LAST_WIN_DATA.length);
    const winData = LAST_WIN_DATA[randomIndex];

    // Broadcast to all connected clients
    this.server.emit('gameService-last-win', winData);
  }
}

