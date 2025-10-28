import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Event } from '../model/event.entity';
import { EventRepository } from '../repository/event.repository';

@Injectable()
export class EventService {
  constructor(
    private readonly eventRepository: EventRepository,
    @InjectModel(Event.name) private eventModel: Model<Event>,
  ) {}

  async findActiveEvents(): Promise<Event[]> {
    return this.eventRepository.findActiveEvents();
  }

  async completeEvent(eventId: string, winner: string): Promise<Event | null> {
    return this.eventRepository.update(eventId, { 
      winner, 
      isCompleted: true 
    });
  }

  async createEvent(theme: string, startDate: Date, numberOfQuestions: number, minPlayers: number = 2): Promise<Event> {
    return this.eventRepository.create({
      theme,
      startDate,
      numberOfQuestions,
      minPlayers
    });
  }

  async getNextEvent(): Promise<Event | null> {
    const now = new Date();
    return this.eventModel
      .findOne({
        isCompleted: false,
        startDate: { $gt: now }
      })
      .sort({ startDate: 1 })
      .exec();
  }

  async openLobby(eventId: string): Promise<Event | null> {
    return this.eventRepository.update(eventId, { lobbyOpen: true });
  }

  async getEventsReadyForLobby(): Promise<Event[]> {
    return this.eventModel
      .find({ 
        isCompleted: false, 
        lobbyOpen: false 
      })
      .exec();
  }

  async startEvent(eventId: string): Promise<Event | null> {
    return this.eventRepository.update(eventId, { isStarted: true });
  }
}