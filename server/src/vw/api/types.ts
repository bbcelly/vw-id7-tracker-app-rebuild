// VW WeConnect app-API constants and wire types. Ported from the live-verified
// original project (wv). See docs/vw-auth-migration.md (+ addendum) for the
// protocol history — the constants and header quirks here are load-bearing.

export interface VwTokens {
  accessToken: string;
  idToken: string;
  expiresAt: number; // unix ms
  refreshToken?: string;
}

export interface VwVehiclesResponse {
  data: Array<{ vin: string }>;
}

export interface VwSelectiveStatusResponse {
  charging?: unknown;
  measurements?: unknown;
  climatisation?: unknown;
  access?: unknown;
}

export interface VwParkingPositionResponse {
  data?: {
    lat: number;
    lon: number;
    carCapturedTimestamp?: string;
  };
}

/** Shape of selectivestatus (jobs=access,charging,climatisation,measurements) + parking. */
export interface VwIdData {
  access?: {
    accessStatus?: { value?: { overallStatus?: string; doorLockStatus?: string } };
  };
  charging?: {
    batteryStatus?: {
      value?: { currentSOC_pct?: number; cruisingRangeElectric_km?: number };
    };
    chargingStatus?: { value?: { chargingState?: string } };
    chargingSettings?: { value?: { targetSOC_pct?: number; maxChargeCurrentAC?: string } };
    plugStatus?: { value?: { externalPower?: string } };
  };
  climatisation?: {
    climatisationStatus?: { value?: { climatisationState?: string } };
    climatisationSettings?: { value?: { targetTemperature_C?: number } };
  };
  measurements?: {
    odometerStatus?: { value?: { odometer?: number } };
  };
  parking?: {
    data?: { carIsParked?: boolean; lat?: number; lon?: number };
  };
}

export const VW_CLIENT_ID =
  "a24fba63-34b3-4d43-b181-942111e6bda8@apps_vw-dilab_com";
export const VW_REDIRECT_URI = "weconnect://authenticated";
export const VW_USER_AGENT = "Volkswagen/3.61.0-android/14";
export const VW_ANDROID_PACKAGE_NAME = "com.volkswagen.weconnect";
export const VW_SCOPE = "openid profile badge cars dealers vin";
// Pure authorization-code flow + PKCE. VW disabled the implicit grant for this
// client around 2026-06 (authorize with the hybrid response_type now 500s with
// "Grant type 'implicit' not allowed for the client"). The code is exchanged at
// the BFF OIDC token endpoint.
export const VW_RESPONSE_TYPE = "code";

export const VW_HOST_IDP = "https://identity.vwgroup.io";
export const VW_HOST_BFF = "https://emea.bff.cariad.digital";

// The Auth0 login pages reject the VW Android User-Agent (401); they expect a
// browser UA. The BFF token endpoint conversely wants the VW app UA.
export const BROWSER_UA =
  "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";
