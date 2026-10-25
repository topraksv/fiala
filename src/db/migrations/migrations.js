// This file is required for Expo/React Native SQLite migrations - https://orm.drizzle.team/quick-sqlite/expo

import journal from './meta/_journal.json';
import m0000 from './0000_baseline.sql';
import m0001 from './0001_medicine_cabinet.sql';
import m0002 from './0002_cabinet_details.sql';
import m0003 from './0003_cabinet_members.sql';
import m0004 from './0004_household_photo.sql';
import m0005 from './0005_who_changed.sql';
import m0006 from './0006_box_check.sql';
import m0007 from './0007_documents.sql';
import m0008 from './0008_doses.sql';
import m0009 from './0009_person_health.sql';

  export default {
    journal,
    migrations: {
      m0000,
m0001,
m0002,
m0003,
m0004,
m0005,
m0006,
m0007,
m0008,
m0009
    }
  }
  