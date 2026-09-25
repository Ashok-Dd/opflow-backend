-- OPflow · 1700 · Health tips removed; WHO-based first aid added to every emergency situation.
--   - The educational health-tips feature is removed from the product, so its tables go.
--   - Emergency situations are now 14 (snake bite, burns, dog bite, stroke, fits… each separate).
--   - first_aid_guides: Do's, Don'ts and "Call 108 now if…" for each situation, with the WHO documents they
--     follow. A page can't be published without a named doctor's review, or while its source is unconfirmed.
-- GENERATED from app/lib/mock/data.dart and app/lib/mock/first_aid.dart — keep them in step.

-- migrate:up

drop table if exists article_feedback;
drop table if exists health_articles;
drop table if exists daily_tips;
drop table if exists health_topics;
delete from app_config where key = 'health_tips.enabled';

-- Emergency situations: replace the list (type links are rebuilt too).
delete from emergency_kind_types;
delete from emergency_kinds;
insert into emergency_kinds (id, name, detail, icon, sort) values
  ('snake', 'Snake bite', 'Any snake bite, even with no pain', 'pest_control_outlined', 1),
  ('heart', 'Chest pain / heart attack', 'Chest pain, pain in arm or jaw, cold sweat', 'favorite', 2),
  ('stroke', 'Sudden weakness (stroke)', 'Face drooping, one side weak, trouble speaking', 'psychology_outlined', 3),
  ('accident', 'Accident or heavy bleeding', 'Road accident, fall, broken bone, head injury', 'personal_injury_outlined', 4),
  ('burn', 'Burns', 'Fire, hot water, electricity or chemical burn', 'local_fire_department_outlined', 5),
  ('child', 'Child is very sick', 'Not drinking, fits, very sleepy, breathing fast', 'child_care', 6),
  ('fits', 'Fits (seizure)', 'Shaking of the body, not responding', 'bolt', 7),
  ('breathing', 'Breathing problem', 'Cannot breathe well, asthma attack', 'air', 8),
  ('pregnancy', 'Pregnancy problem', 'Bleeding, fits, very bad headache or stomach pain', 'pregnant_woman', 9),
  ('poison', 'Swallowed poison', 'Pesticide, kerosene, cleaning liquid, too many tablets', 'warning_amber_rounded', 10),
  ('animalbite', 'Dog or animal bite', 'Bite or scratch from a dog, cat or monkey', 'pets_outlined', 11),
  ('heat', 'Heat stroke', 'Very hot body, confusion, fainting in the heat', 'wb_sunny_outlined', 12),
  ('eye', 'Eye injury', 'Chemical or object in the eye, sudden loss of sight', 'visibility_outlined', 13),
  ('other', 'Other urgent problem', 'Anything else that cannot wait', 'emergency_outlined', 14);
insert into emergency_kind_types (kind_id, type_id) values
  ('snake', 'general'),
  ('snake', 'surgeon'),
  ('heart', 'heart'),
  ('heart', 'general'),
  ('stroke', 'brain'),
  ('stroke', 'general'),
  ('accident', 'bone'),
  ('accident', 'surgeon'),
  ('burn', 'surgeon'),
  ('burn', 'general'),
  ('child', 'child'),
  ('fits', 'brain'),
  ('fits', 'general'),
  ('breathing', 'lungs'),
  ('breathing', 'general'),
  ('pregnancy', 'women'),
  ('poison', 'general'),
  ('animalbite', 'general'),
  ('animalbite', 'surgeon'),
  ('heat', 'general'),
  ('eye', 'eye'),
  ('other', 'general');

create table first_aid_guides (
  kind_id             text primary key references emergency_kinds(id) on delete cascade,
  intro               text,
  signs               text[] not null default '{}',
  call_now_if         text[] not null check (cardinality(call_now_if) > 0),
  dos                 text[] not null check (cardinality(dos) > 0),
  donts               text[] not null check (cardinality(donts) > 0),
  sources             jsonb not null check (jsonb_typeof(sources) = 'array' and jsonb_array_length(sources) > 0),
                        -- [{"title": "WHO fact sheet: …", "year": 2023, "url": "https://www.who.int/…"}]
  source_to_confirm   boolean not null default false,  -- the exact WHO document is still being confirmed
  locale              varchar(5) not null default 'en',
  status              article_status not null default 'in_review',
  reviewed_by_doctor  varchar(80),
  reviewed_at         timestamptz,
  published_at        timestamptz,
  updated_at          timestamptz not null default now(),
  -- Emergency advice goes live only after a named doctor checked it against its WHO source.
  constraint first_aid_published_reviewed check (
    status <> 'published'
    or (reviewed_by_doctor is not null and reviewed_at is not null and published_at is not null and not source_to_confirm))
);
create trigger first_aid_guides_set_updated_at before update on first_aid_guides
  for each row execute function set_updated_at();

insert into first_aid_guides (kind_id, intro, signs, call_now_if, dos, donts, sources, source_to_confirm) values
  ('snake', 'Every snake bite needs a hospital, even if there is no pain or swelling. Antivenom is the only treatment.', '{}'::text[], array['Always. Call 108 or go to the nearest hospital now.', 'Faster if: eyelids drooping, trouble swallowing or breathing, bleeding from gums or the bite, or very sleepy.']::text[], array['Move away from the snake, calmly.', 'Keep the person calm and as still as possible. Moving spreads the venom faster.', 'Take off rings, bangles, anklets, watches and tight clothes near the bite, before swelling starts.', 'Keep the bitten arm or leg still, like with a splint, and at the level of the heart.', 'Take the person to hospital as fast as possible. Carry them if you can; do not let them walk or run.', 'Note the time of the bite and tell the doctor about any new signs on the way.']::text[], array['Do not tie a tight cloth, rope or band (tourniquet) around the limb.', 'Do not cut the bite or try to suck out the venom.', 'Do not put ice, herbs, chemicals, or any traditional remedy on the bite.', 'Do not go to a traditional healer. It wastes time the person does not have.', 'Do not try to catch or kill the snake. Only take a photo if it is completely safe.', 'Do not give any medicine, painkiller or alcohol on your own.']::text[], '[{"title": "WHO fact sheet: Snakebite envenoming", "year": 2023, "url": "https://www.who.int/news-room/fact-sheets/detail/snakebite-envenoming"}, {"title": "WHO South-East Asia: Guidelines for the management of snakebites, 2nd edition", "year": 2016, "url": null}]'::jsonb, false),
  ('animalbite', 'Bites and scratches from dogs, cats, monkeys and other animals can cause rabies, which can be prevented with vaccine but is deadly once signs start.', '{}'::text[], array['The bite is deep, bleeding a lot, or on the face, head, neck or hands.', 'Go to a hospital the same day for every bite or scratch that breaks the skin, and for licks on broken skin.']::text[], array['Wash the wound straight away with soap and plenty of running water for about 15 minutes.', 'After washing, put on an antiseptic such as povidone-iodine if you have it.', 'Go to a hospital or health centre the same day for the anti-rabies vaccine.', 'Tell the doctor which animal it was and whether it has been vaccinated.', 'Take every vaccine dose on the dates the doctor gives you.']::text[], array['Do not wait to see if the animal falls sick before getting the vaccine.', 'Do not skip the vaccine because the bite looks small.', 'Do not put anything else on the wound (chilli, turmeric, oil, powders).']::text[], '[{"title": "WHO fact sheet: Rabies", "year": 2024, "url": "https://www.who.int/news-room/fact-sheets/detail/rabies"}]'::jsonb, false),
  ('burn', null, '{}'::text[], array['The burn is large, deep, or on the face, hands, feet, private parts or joints.', 'It was caused by electricity or a chemical, or the person breathed in smoke.', 'The person is a small child or an older person.']::text[], array['Make sure you are safe first. Switch off electricity or gas before touching the person.', 'Stop the burning: if clothes are on fire, stop, drop and roll, or cover with a blanket.', 'Remove clothes and jewellery near the burn, unless they are stuck to the skin.', 'Cool the burn with cool (not cold) running water as soon as possible.', 'Cover the burn loosely with a clean cloth or clean plastic wrap.', 'Keep the person warm and take them to a hospital.']::text[], array['Do not put paste, oil, haldi (turmeric), toothpaste or raw cotton on the burn.', 'Do not put ice on the burn. It makes the injury deeper.', 'Do not keep cooling for too long, especially in children. The body can get too cold.', 'Do not break blisters.', 'Do not put any cream or medicine on the burn until a health worker sees it.']::text[], '[{"title": "WHO fact sheet: Burns", "year": 2023, "url": "https://www.who.int/news-room/fact-sheets/detail/burns"}]'::jsonb, false),
  ('heart', null, array['Pain or pressure in the centre of the chest.', 'Pain in the arms, left shoulder, elbows, jaw or back.', 'Breathlessness, feeling sick or vomiting, dizziness, cold sweat, looking pale.', 'Women more often have breathlessness, sickness, and back or jaw pain.']::text[], array['Any of these signs. Call 108 now. Every minute counts.']::text[], array['Stop all activity. Sit down and rest in a comfortable position.', 'Loosen tight clothes.', 'If the person has chest-pain medicine prescribed by their doctor, help them take it as prescribed.', 'If the person collapses and is not breathing normally, start CPR if you know how, and keep going until help arrives.']::text[], array['Do not let the person drive themselves to hospital.', 'Do not wait to see if the pain goes away.', 'Do not give food, drink or any medicine that was not prescribed.']::text[], '[{"title": "WHO fact sheet: Cardiovascular diseases (CVDs)", "year": 2021, "url": "https://www.who.int/news-room/fact-sheets/detail/cardiovascular-diseases-(cvds)"}, {"title": "WHO/ICRC Basic Emergency Care: approach to the acutely ill and injured", "year": 2018, "url": null}]'::jsonb, false),
  ('stroke', null, array['Sudden weakness or numbness of the face, arm or leg, most often on one side.', 'Face drooping, trouble speaking or understanding.', 'Sudden trouble seeing, walking, dizziness or loss of balance.', 'Sudden very bad headache, fainting.']::text[], array['Any of these signs, even if they go away. Call 108 now. Treatment works best in the first hours.']::text[], array['Note the exact time the signs started, and tell the doctor.', 'Go to a hospital that can do a brain scan, as fast as possible.', 'If the person is drowsy or vomiting, lay them on their side.']::text[], array['Do not give food, water or medicine. Swallowing may not be safe.', 'Do not wait for the signs to pass or let the person "sleep it off".']::text[], '[{"title": "WHO fact sheet: Cardiovascular diseases (CVDs)", "year": 2021, "url": "https://www.who.int/news-room/fact-sheets/detail/cardiovascular-diseases-(cvds)"}]'::jsonb, false),
  ('fits', null, '{}'::text[], array['The fit lasts more than 5 minutes, or another fit starts before the person wakes up.', 'It is the person''s first fit, they are pregnant, injured, in water, or have trouble breathing afterwards.']::text[], array['Stay calm and note the time the fit started.', 'Move hard or sharp things away. Put something soft under the head.', 'Loosen tight clothes around the neck.', 'When the jerking stops, turn the person onto their side so they can breathe.', 'Stay with them until they are fully awake.']::text[], array['Do not put anything in the mouth: no spoon, cloth, fingers or water.', 'Do not hold the person down or try to stop the movements.', 'Do not give food, drink or medicine until the person is fully awake.']::text[], '[{"title": "WHO mhGAP Intervention Guide 2.0: Epilepsy / seizures", "year": 2016, "url": null}, {"title": "WHO fact sheet: Epilepsy", "year": 2024, "url": "https://www.who.int/news-room/fact-sheets/detail/epilepsy"}]'::jsonb, false),
  ('breathing', null, '{}'::text[], array['The person cannot speak in full sentences, or is fighting for breath.', 'Lips or fingernails turn blue or grey.', 'The reliever inhaler does not help, or the person is very drowsy or confused.']::text[], array['Help the person sit upright and stay calm.', 'If they have a reliever inhaler, help them use it as their doctor prescribed (with a spacer if they have one).', 'Move them away from smoke, dust or whatever set it off.', 'Loosen tight clothes.']::text[], array['Do not make the person lie flat.', 'Do not give medicines that were not prescribed for them.']::text[], '[{"title": "WHO fact sheet: Asthma", "year": 2024, "url": "https://www.who.int/news-room/fact-sheets/detail/asthma"}]'::jsonb, true),
  ('accident', null, '{}'::text[], array['Heavy bleeding, a head injury, or the person is not fully awake.', 'Possible broken bones, or neck or back pain after a fall or road accident.']::text[], array['Make the place safe first: watch for traffic, fire or falling objects.', 'Call 108.', 'Press firmly on a bleeding wound with a clean cloth, and keep pressing.', 'If the neck or back may be hurt, keep the head and body still.', 'Keep the person warm and talk to them calmly.', 'If the person is not awake but breathing, and there is no neck or back injury, turn them onto their side.']::text[], array['Do not move the person unless they are in danger where they are.', 'Do not pull out objects stuck in a wound. Press around them instead.', 'Do not give food or drink.']::text[], '[{"title": "WHO/ICRC Basic Emergency Care: approach to the acutely ill and injured", "year": 2018, "url": null}]'::jsonb, false),
  ('child', 'These are danger signs in a child. A child with any one of them needs a hospital now.', '{}'::text[], array['Not able to drink or breastfeed.', 'Vomits everything.', 'Has had fits.', 'Very sleepy or hard to wake.', 'Breathing fast or with difficulty, or the chest pulls in with each breath.', 'A baby under 2 months with fever, or a body that feels cold.']::text[], array['Go to the nearest hospital now.', 'On the way, keep breastfeeding or giving small sips of fluid, if the child can drink.', 'Keep a small baby warm, skin to skin with the mother if possible.', 'Take the child''s vaccine card and any medicines they are taking.']::text[], array['Do not wait until morning or to see if it gets better.', 'Do not give medicines on your own.', 'Do not lose time with home remedies.']::text[], '[{"title": "WHO Integrated Management of Childhood Illness (IMCI): Chart booklet", "year": 2014, "url": null}]'::jsonb, false),
  ('pregnancy', 'These are danger signs in pregnancy. Any one of them needs a hospital now.', '{}'::text[], array['Any bleeding from the vagina.', 'Fits.', 'Very bad headache with blurred vision.', 'Fever, and too weak to get out of bed.', 'Very bad pain in the stomach.', 'Fast or difficult breathing.']::text[], array['Go to the hospital now. Take someone with you.', 'Take your pregnancy card or reports.', 'While waiting for transport, lie on your left side.']::text[], array['Do not wait until morning.', 'Do not take any medicine or home remedy on your own.']::text[], '[{"title": "WHO Pregnancy, childbirth, postpartum and newborn care: a guide for essential practice, 3rd edition", "year": 2015, "url": null}]'::jsonb, false),
  ('heat', null, array['Very hot body, confusion, fainting, fits, or very hot and dry or very sweaty skin, after time in the heat.']::text[], array['The person is confused, faints, has fits, or their body stays very hot. This is heat stroke: call 108.']::text[], array['Move the person to a cool, shaded place.', 'Remove extra clothes.', 'Cool the body: wet the skin with cool water, use wet cloths and fan them.', 'If they are awake and can swallow, give small sips of water.']::text[], array['Do not give drinks to a person who is not fully awake.', 'Do not leave the person alone.']::text[], '[{"title": "WHO fact sheet: Heat and health", "year": 2024, "url": "https://www.who.int/news-room/fact-sheets/detail/climate-change-heat-and-health"}]'::jsonb, false),
  ('poison', null, '{}'::text[], array['Always, for anything swallowed that could be poison, including pesticides, kerosene, cleaning liquids or too many tablets.', 'Faster if the person is drowsy, has fits, or has trouble breathing.']::text[], array['Call 108 or go to the nearest hospital now.', 'Take the container, bottle, packet or tablet strip with you.', 'If poison is on the skin, remove the clothes and wash the skin with plenty of water.', 'If it is a gas or fumes, move the person to fresh air.']::text[], array['Do not make the person vomit.', 'Do not give salt water, milk, oil or anything by mouth unless a doctor says so.', 'Do not wait for signs to appear.']::text[], '[{"title": "WHO/ICRC Basic Emergency Care: approach to the acutely ill and injured", "year": 2018, "url": null}]'::jsonb, true),
  ('eye', null, '{}'::text[], array['A chemical went into the eye, something is stuck in the eye, or sight suddenly gets worse.']::text[], array['For a chemical: rinse the eye straight away with plenty of clean running water for at least 15 minutes, holding the eye open.', 'Remove contact lenses if the person wears them.', 'For something stuck in the eye: cover it lightly with a clean cup or pad, without pressing.', 'Go to an eye hospital or emergency now.']::text[], array['Do not rub the eye.', 'Do not try to pull out anything stuck in the eye.', 'Do not put drops, ghee, milk or any home remedy in the eye.']::text[], '[{"title": "WHO/ICRC Basic Emergency Care: approach to the acutely ill and injured", "year": 2018, "url": null}]'::jsonb, true);

-- migrate:down

drop table if exists first_aid_guides;
delete from emergency_kind_types;
delete from emergency_kinds;

create table health_topics (
  id    text primary key check (id ~ '^[a-z]+$'),
  name  varchar(60) not null,
  icon  varchar(60) not null,
  sort  smallint not null default 0
);
create table health_articles (
  id                  text primary key check (id ~ '^[a-z0-9-]+$'),
  topic_id            text not null references health_topics(id),
  title               varchar(120) not null,
  summary             varchar(300) not null,
  minutes             smallint not null check (minutes between 1 and 30),
  sections            jsonb not null check (jsonb_typeof(sections) = 'array'),
  see_doctor          text[] not null default '{}',
  go_now              text[] not null default '{}',
  doctor_type_id      text not null references doctor_types(id),
  helpline            jsonb,
  locale              varchar(5) not null default 'en',
  status              article_status not null default 'draft',
  reviewed_by_doctor  varchar(80),
  reviewed_at         timestamptz,
  published_at        timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint articles_published_reviewed
    check (status <> 'published' or (reviewed_by_doctor is not null and reviewed_at is not null and published_at is not null))
);
create index health_articles_topic_idx on health_articles (topic_id) where status = 'published';
create trigger health_articles_set_updated_at before update on health_articles for each row execute function set_updated_at();
create table article_feedback (
  id          bigint generated always as identity primary key,
  article_id  text not null references health_articles(id) on delete cascade,
  user_id     uuid references users(id) on delete set null,
  helpful     boolean not null,
  created_at  timestamptz not null default now()
);
create index article_feedback_article_idx on article_feedback (article_id);
create table daily_tips (
  id      smallint generated always as identity primary key,
  text    varchar(200) not null,
  locale  varchar(5) not null default 'en',
  active  boolean not null default true
);

insert into health_topics (id, name, icon, sort) values
  ('fever', 'Fever and infections', 'thermostat', 1),
  ('stomach', 'Stomach and water', 'water_drop_outlined', 2),
  ('children', 'Children', 'child_care', 3),
  ('women', 'Women and pregnancy', 'pregnant_woman', 4),
  ('season', 'Rain and summer', 'wb_sunny_outlined', 5),
  ('longterm', 'Sugar and BP', 'monitor_heart_outlined', 6),
  ('daily', 'Daily habits', 'self_improvement', 7);

insert into daily_tips (text) values
  ('Drink a glass of water when you wake up, and keep a bottle with you through the day.'),
  ('Wash your hands with soap for 20 seconds before eating and after using the toilet.'),
  ('Walk for 30 minutes today. Even two walks of 15 minutes help your heart.'),
  ('Once a week, empty water from coolers, pots and old tyres. Mosquitoes breed in still water.'),
  ('Take your BP or sugar tablets at the same time every day, even when you feel fine.'),
  ('Every 20 minutes on a screen, look at something far away for 20 seconds.'),
  ('Brush your teeth twice a day, for two minutes each time.'),
  ('Fill half your plate with vegetables and dal. Less rice, less oil, less salt.'),
  ('Sleep at the same time every night. Keep the phone away for the last half hour.'),
  ('Keep a packet of ORS at home. It saves lives when someone has loose motions.'),
  ('Keep your child''s vaccine card safe and take it to every visit.'),
  ('Feeling low for many days? Talk to someone you trust, or call Tele-MANAS on 14416.');

insert into emergency_kinds (id, name, detail, icon, sort) values
  ('child', 'Child is very sick', 'High fever, not feeding, breathing fast, fits', 'child_care', 1),
  ('heart', 'Chest pain / heart', 'Chest pain, heavy breathing, heart beating very fast', 'favorite', 2),
  ('accident', 'Accident or injury', 'Road accident, fall, broken bone, head injury, bleeding', 'personal_injury_outlined', 3),
  ('breathing', 'Breathing problem', 'Cannot breathe well, asthma attack', 'air', 4),
  ('brain', 'Fits or sudden weakness', 'Fits, one side weak, face drooping, not waking up', 'psychology_outlined', 5),
  ('pregnancy', 'Pregnancy problem', 'Bleeding, strong stomach pain, labour pain', 'pregnant_woman', 6),
  ('eye', 'Eye injury', 'Something went in the eye, chemical in eye, sudden loss of sight', 'visibility_outlined', 7),
  ('poison', 'Poison or snake bite', 'Swallowed poison, snake bite, dog bite', 'warning_amber_rounded', 8),
  ('other', 'Other urgent problem', 'Anything else that cannot wait', 'emergency_outlined', 9);

insert into emergency_kind_types (kind_id, type_id) values
  ('child', 'child'),
  ('heart', 'heart'),
  ('heart', 'general'),
  ('accident', 'bone'),
  ('accident', 'surgeon'),
  ('breathing', 'lungs'),
  ('breathing', 'general'),
  ('brain', 'brain'),
  ('brain', 'general'),
  ('pregnancy', 'women'),
  ('eye', 'eye'),
  ('poison', 'general'),
  ('poison', 'surgeon'),
  ('other', 'general');

insert into app_config (key, value, description) values
  ('health_tips.enabled', 'true'::jsonb, 'Kill switch: health tips');
