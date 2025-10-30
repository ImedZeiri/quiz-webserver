import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Event } from '../model/event.entity';

@Injectable()
export class EventService {
  constructor(
    @InjectModel(Event.name)
    private readonly eventModel: Model<Event>,
  ) {}

  async findActiveEvents(): Promise<Event[]> {
    return this.eventModel.find({ isCompleted: false }).sort({ startDate: 1 }).exec();
  }

  async completeEvent(eventId: string, winnerPhone: string): Promise<Event | null> {
    return this.eventModel.findByIdAndUpdate(
      eventId,
      { winner: winnerPhone, isCompleted: true },
      { new: true }
    ).exec();
  }

  async createEvent(theme: string, startDate: Date, numberOfQuestions: number, minPlayers: number = 2): Promise<Event> {
    const event = new this.eventModel({
      theme,
      startDate,
      numberOfQuestions,
      minPlayers
    });
    return event.save();
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
    return this.eventModel.findByIdAndUpdate(
      eventId,
      { lobbyOpen: true },
      { new: true }
    ).exec();
  }

  async getEventsReadyForLobby(): Promise<Event[]> {
    const now = new Date();
    const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000);
    
    return this.eventModel.find({
      isCompleted: false,
      lobbyOpen: false,
      startDate: { $gte: fiveMinutesAgo, $lte: new Date(now.getTime() + 10 * 60 * 1000) }
    }).exec();
  }

  async startEvent(eventId: string): Promise<Event | null> {
    return this.eventModel.findByIdAndUpdate(
      eventId,
      { isStarted: true },
      { new: true }
    ).exec();
  }
}