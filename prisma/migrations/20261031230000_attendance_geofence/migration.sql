ALTER TABLE "organisations" ADD COLUMN "attendance_security" JSONB;

ALTER TABLE "attendance_records"
ADD COLUMN "latitude" DOUBLE PRECISION,
ADD COLUMN "longitude" DOUBLE PRECISION,
ADD COLUMN "location_accuracy_m" DOUBLE PRECISION,
ADD COLUMN "mock_location_detected" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "geofence_status" VARCHAR(20),
ADD COLUMN "geofence_distance_m" DOUBLE PRECISION;
