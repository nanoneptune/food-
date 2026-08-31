export interface Complaint {
  id: string;
  name: string;
  phoneNumber: string;
  location?: string;
  query: string;
  status: 'pending' | 'under_review' | 'investigating' | 'resolved';
  chatHistory: string | VoiceInteraction[]; // Stored as JSON string in SQL or parsed array in UI
  mediaUrls?: string | string[]; // Stored as JSON string or parsed array
  audioUrl?: string;
  createdAt: number;
  adminReply?: string;
  adminReplyAt?: number;
}

export interface KBDocument {
  id: string;
  content: string;
  name: string;
  type: string;
  createdAt: number;
}

export interface VoiceInteraction {
  id: string;
  text: string;
  sender: 'user' | 'assistant';
  timestamp: number;
}

export interface UserProfile {
  name: string;
  phone: string;
  location?: string;
  photoUrl?: string;
}
