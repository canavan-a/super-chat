import React from 'react';
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  File,
  Link,
  Lock,
  LucideIcon,
  Menu,
  MoreVertical,
  Paperclip,
  Reply,
  Send,
  Settings,
  Shield,
  SmilePlus,
  Trash2,
  UserPlus,
  Users,
  X,
} from 'lucide-react-native';

// lucide-react-native is the icon set used everywhere in the app, the same
// one super-badger uses, so both apps draw icons the same way. It renders
// through react-native-svg, whose web resolution is fixed in vite.config.ts.
export type IconName =
  | 'menu'
  | 'kebab'
  | 'gear'
  | 'chevron-left'
  | 'chevron-right'
  | 'chevron-down'
  | 'trash'
  | 'close'
  | 'check'
  | 'copy'
  | 'send'
  | 'reply'
  | 'react'
  | 'attach'
  | 'file'
  | 'download'
  | 'invite'
  | 'members'
  | 'shield'
  | 'lock'
  | 'link';

const ICONS: Record<IconName, LucideIcon> = {
  menu: Menu,
  kebab: MoreVertical,
  gear: Settings,
  'chevron-left': ChevronLeft,
  'chevron-right': ChevronRight,
  'chevron-down': ChevronDown,
  trash: Trash2,
  close: X,
  check: Check,
  copy: Copy,
  send: Send,
  reply: Reply,
  react: SmilePlus,
  attach: Paperclip,
  file: File,
  download: Download,
  invite: UserPlus,
  members: Users,
  shield: Shield,
  lock: Lock,
  link: Link,
};

export function Icon({
  name,
  size = 20,
  color = '#000',
  strokeWidth = 2,
}: {
  name: IconName;
  size?: number;
  color?: string;
  strokeWidth?: number;
}): React.JSX.Element {
  const IconComponent = ICONS[name];
  return <IconComponent size={size} color={color} strokeWidth={strokeWidth} fill="none" />;
}
