import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

@Schema()
export class Event extends Document {
  @Prop({ required: true, type: String })
  theme: string;

  @Prop({ required: true, type: Date })
  startDate: Date;

  @Prop({ required: true, type: Number })
  numberOfQuestions: number;

  @Prop({ 
    type: String, 
    default: null 
  })
  winner: string;

  @Prop({ default: false, type: Boolean })
  isCompleted: boolean;

  @Prop({ default: 2, type: Number })
  minPlayers: number;

  @Prop({ default: false, type: Boolean })
  lobbyOpen: boolean;

  @Prop({ default: false, type: Boolean })
  isStarted: boolean;

  @Prop({ 
    type: Date, 
    default: null 
  })
  completedAt: Date;

  @Prop({ default: false, type: Boolean })
  nextEventCreated: boolean;
}

export const EventSchema = SchemaFactory.createForClass(Event);

// Hook pour détecter les changements automatiquement
EventSchema.post('findOneAndUpdate', function(doc) {
  if (doc && global.gatewayService) {
    global.gatewayService.handleEventUpdated(doc);
  }
});

EventSchema.post('save', function(doc) {
  if (doc && global.gatewayService) {
    global.gatewayService.handleEventUpdated(doc);
  }
});

EventSchema.post('findOneAndDelete', function(doc) {
  if (doc && global.gatewayService) {
    global.gatewayService.handleEventDeleted(doc.id);
  }
});