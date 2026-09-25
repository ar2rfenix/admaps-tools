# Changelog

## 0.2.9
- First public release.
- Worlds on other game systems: Alt+W no longer throws an error on scenes with regions, and three floor tools no longer
  log a 404 in the console.

## 0.2.8
- A token dropped while a Levels floor is selected falls to the floor below when that floor has nothing at the drop
  point; bare ground counts as a floor at 0.
- Partial tile fade: a token that walks in to stop under a roof fades it at once; a token passing under the roof or
  brushing its edge no longer blacks it out.

## 0.2.7
- Import scenes from folder: scenes are created inactive. In a world without an active scene the first imported scene
  used to come out black.

## 0.2.6
- Scene variations: switching with the Levels floor panel open no longer rewrites elevations, teleports keep working
  after a switch, and the selected floor is restored after the redraw.
- Quick keyboard movement on stairs no longer drops a token through the floor.

## 0.2.5
- A token dropped while a Levels floor is selected lands on that floor at the drop point, and the floor panel switches
  to the token's floor.

## 0.2.4
- Faster floor lookups for elevation regions.
- Partial tile fade tool.
