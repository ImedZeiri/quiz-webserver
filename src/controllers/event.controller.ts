import { Controller, Get, Post, Body } from '@nestjs/common';
import { EventService } from 'src/services/event.service';
import type { CreateEventData } from 'src/types/event.interface';

@Controller('events')
export class EventController {
  constructor(private readonly eventService: EventService) {}

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
}
