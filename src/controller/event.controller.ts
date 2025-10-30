import { Controller, Get, Post, Body, Param, Inject } from '@nestjs/common';
import { EventService } from '../service/event.service';
import { GatewayService } from '../service/gateway.service';
import { Event } from '../model/event.entity';
import type { CreateEventData } from 'src/types/event.interface';

@Controller('events')
export class EventController {
  constructor(
    private readonly eventService: EventService,
    @Inject(GatewayService) private readonly gatewayService: GatewayService
  ) {}

  @Get('next')
  async getNextEvent(): Promise<Event | null> {
    return this.eventService.getNextEvent();
  }

  @Get('active')
  async getActiveEvents(): Promise<Event[]> {
    return this.eventService.findActiveEvents();
  }

  @Post()
  async createEvent(@Body() eventData: CreateEventData): Promise<Event> {
    return this.eventService.createEvent(
      eventData.theme,
      new Date(eventData.startDate),
      eventData.numberOfQuestions,
      eventData.minPlayers || 2
    );
  }

  @Post(':id/open-lobby')
  async openLobby(@Param('id') id: string): Promise<Event | null> {
    return this.eventService.openLobby(id);
  }

  @Get('ready-for-lobby')
  async getEventsReadyForLobby(): Promise<Event[]> {
    return this.eventService.getEventsReadyForLobby();
  }

  @Get('in-lobby-window')
  async getEventsInLobbyWindow(): Promise<Event[]> {
    return this.eventService.getEventsInLobbyWindow();
  }

  @Post('force-lobby-check')
  async forceLobbyCheck(): Promise<{ message: string; timestamp: string }> {
    await this.gatewayService.forceEventCheck();
    return {
      message: 'Vérification forcée des lobbies effectuée',
      timestamp: new Date().toISOString()
    };
  }
}