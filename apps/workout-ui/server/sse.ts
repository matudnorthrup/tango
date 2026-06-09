type Subscriber = {
  send: (event: string, data: string) => void;
};

const subscribers = new Set<Subscriber>();

export function addSubscriber(sub: Subscriber): () => void {
  subscribers.add(sub);
  return () => subscribers.delete(sub);
}

export function broadcast(event: string, data: string): void {
  for (const sub of subscribers) {
    try {
      sub.send(event, data);
    } catch {
      subscribers.delete(sub);
    }
  }
}

export function subscriberCount(): number {
  return subscribers.size;
}
