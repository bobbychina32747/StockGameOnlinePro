import { useUIStore } from '../../store';

export function NotificationContainer() {
  const notifications = useUIStore((s) => s.notifications);
  const remove = useUIStore((s) => s.removeNotification);

  if (notifications.length === 0) return null;

  return (
    <div className="notification-container">
      {notifications.map((n) => (
        <div
          key={n.id}
          className={`notification ${n.type}`}
          onClick={() => remove(n.id)}
        >
          {n.message}
        </div>
      ))}
    </div>
  );
}
