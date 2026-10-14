// Barrel das primitivas de animação (ver docs/ux/evidence/fundacao.md).
export { MotionProvider } from "./motion-provider";
export { FadeIn, type FadeInProps } from "./fade-in";
export { SlideIn, type SlideInProps } from "./slide-in";
export { ScaleIn, type ScaleInProps } from "./scale-in";
export {
  StaggerContainer,
  StaggerItem,
  type StaggerContainerProps,
  type StaggerItemProps,
} from "./stagger-container";
export { AnimatedCard, type AnimatedCardProps } from "./animated-card";
export { AnimatedCounter, type AnimatedCounterProps } from "./animated-counter";
export { AnimatedPage } from "./animated-page";
export {
  AnimatedPresenceList,
  PresenceItem,
  type PresenceItemProps,
} from "./animated-presence-list";
export { useEntranceInitial } from "./use-entrance";
export { usePrefersReducedMotion, useReducedMotion } from "@/hooks/use-reduced-motion";
