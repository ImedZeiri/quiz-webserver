import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Event } from '../entities/event.entity';

@Injectable()
export class EventService {
  constructor(
    @InjectRepository(Event)
    private readonly eventRepository: Repository<Event>,
  ) {}

  async findActiveEvents(): Promise<Event[]> {
    return this.eventRepository.find({
      where: { isCompleted: false },
      order: { startDate: 'ASC' },
    });
  }

  async completeEvent(eventId: number, winner: string): Promise<Event | null> {
    await this.eventRepository.update(eventId, {
      winner,
      isCompleted: true,
    });
    return this.eventRepository.findOne({ where: { id: eventId } });
  }

  async createEvent(
    theme: string,
    startDate: Date,
    numberOfQuestions: number,
    minPlayers: number = 2,
  ): Promise<Event> {
    const event = this.eventRepository.create({
      theme,
      startDate,
      numberOfQuestions,
      minPlayers,
    });
    return this.eventRepository.save(event);
  }

  async getNextEvent(): Promise<Event | null> {
    const now = new Date();
    return this.eventRepository
      .createQueryBuilder('event')
      .where('event.isCompleted = :isCompleted', { isCompleted: false })
      .andWhere('event.startDate > :now', { now })
      .orderBy('event.startDate', 'ASC')
      .getOne();
  }

  async openLobby(eventId: number): Promise<Event | null> {
    await this.eventRepository.update(eventId, { lobbyOpen: true });
    return this.eventRepository.findOne({ where: { id: eventId } });
  }
}
