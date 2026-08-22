import { CMPAdapter } from './types'

export class OneTrustAdapter implements CMPAdapter {
  getUserId(payload: any): string | undefined {
    return payload.UserId || payload.identifier || payload.subject
  }

  getPurposes(payload: any): Record<string, boolean> {
    const groups = payload.consentGroups || []
    return {
      necessary: groups.includes('C0001'),
      analytics: groups.includes('C0002'),
      personalization: groups.includes('C0003'),
      marketing: groups.includes('C0004'),
    }
  }

  getMetadata(payload: any): Record<string, any> {
    return {
      source: 'onetrust',
      version: payload.version,
      interactionType: payload.interactionType,
    }
  }
}

export class CookiebotAdapter implements CMPAdapter {
  getUserId(payload: any): string | undefined {
    return payload.userId || payload.serial
  }

  getPurposes(payload: any): Record<string, boolean> {
    return {
      necessary: payload.necessary === true,
      analytics: payload.statistics === true,
      personalization: payload.preferences === true,
      marketing: payload.marketing === true,
    }
  }

  getMetadata(payload: any): Record<string, any> {
    return {
      source: 'cookiebot',
      region: payload.region,
    }
  }
}
