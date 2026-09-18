import type { AutopilotAPI } from '../../shared/types'
declare global {
  interface Window {
    autopilot: AutopilotAPI
  }
}
