-- Add office_ssids for WiFi SSID-based auto check-in (handles non-static IPs)
ALTER TABLE organisations ADD COLUMN IF NOT EXISTS office_ssids TEXT[] NOT NULL DEFAULT '{}';
