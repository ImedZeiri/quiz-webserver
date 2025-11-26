import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Inject,
  Put,
} from '@nestjs/common';
import { EventService } from '../service/event.service';
import { GatewayService } from '../service/gateway.service';
import { Event } from '../model/event.entity';
import type { CreateEventData } from 'src/types/event.interface';

@Controller('events')
export class EventController {
  constructor(
    private readonly eventService: EventService,
    @Inject(GatewayService) private readonly gatewayService: GatewayService,
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
      eventData.minPlayers || 2,
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

  // 🔥 SUPPRESSION: Cette méthode n'existe pas dans EventService
  // @Get('in-lobby-window')
  // async getEventsInLobbyWindow(): Promise<Event[]> {
  //   return this.eventService.getEventsInLobbyWindow();
  // }

  @Post('force-lobby-check')
  async forceLobbyCheck(): Promise<{ message: string; timestamp: string }> {
    await this.gatewayService.forceEventCheck();
    return {
      message: 'Vérification forcée des lobbies effectuée',
      timestamp: new Date().toISOString(),
    };
  }

  @Put(':id')
  async updateEvent(
    @Param('id') id: string,
    @Body()
    updates: Partial<
      Pick<
        Event,
        'theme' | 'startDate' | 'numberOfQuestions' | 'minPlayers' | 'lobbyOpen'
      >
    >,
  ): Promise<Event | null> {
    const normalized: any = { ...updates };
    if (updates.startDate) {
      normalized.startDate = new Date(updates.startDate as any);
    }

    /*   console.log(`📝 Mise à jour de l'événement ${id} avec:`, normalized); */

    // Les hooks MongoDB se chargeront automatiquement de la notification
    const result = await this.eventService.updateEvent(id, normalized);

    // Force une vérification immédiate pour s'assurer que le lobby est mis à jour
    if (result) {
      setTimeout(() => {
        this.gatewayService.forceEventUpdate(id);
      }, 100);
    }

    return result;
  }

  @Post(':id/force-update')
  async forceEventUpdate(
    @Param('id') id: string,
  ): Promise<{ message: string; timestamp: string }> {
    await this.gatewayService.forceEventUpdate(id);
    return {
      message: "Mise à jour forcée de l'événement effectuée",
      timestamp: new Date().toISOString(),
    };
  }
}