/** @flow */
import path from 'path';
import fs from 'fs';
import R from 'ramda';
import { glob } from '../../../utils';
import { loadConsumer, Consumer } from '../../../consumer';
import BitMap from '../../../consumer/bit-map';
import { BitId } from '../../../bit-id';
import { DEFAULT_INDEX_NAME } from '../../../constants';

export default async function addAction(componentPaths: string[], id?: string, index?: string, specs?: string[]): Promise<Object> {

  function getPathRelativeToProjectRoot(componentPath, projectRoot) {
    if (!componentPath) return componentPath;
    const absPath = path.resolve(componentPath);
    return absPath.replace(`${projectRoot}${path.sep}`, '');
  }

  async function addBitMapRecords(componentPath: string, bitMap: BitMap, consumer: Consumer) {

    const addToBitMap = (componentId, files, indexFile, specsFiles): { id: string, files: string[] } => {
      const relativeSpecs = specsFiles ?
        specs.map(spec => getPathRelativeToProjectRoot(spec, consumer.getPath())) : [];
      bitMap.addComponent(componentId.toString(), files, indexFile, relativeSpecs);
      return { id: componentId.toString(), files };
    };

    let parsedId: BitId;
    let componentExists = false;
    if (id) {
      componentExists = bitMap.isComponentExist(id);
      parsedId = BitId.parse(id);
    }
    let stat;
    try {
      stat = fs.lstatSync(componentPath);
    } catch (err) {
      throw new Error(`The path ${componentPath} doesn't exist`);
    }
    if (stat.isFile()) {
      const pathParsed = path.parse(componentPath);
      const relativeFilePath = getPathRelativeToProjectRoot(componentPath, consumer.getPath());

      if (!parsedId) {
        let dirName = pathParsed.dir;
        if (!dirName) {
          const absPath = path.resolve(componentPath);
          dirName = path.dirname(absPath);
        }
        const lastDir = R.last(dirName.split(path.sep));
        parsedId = new BitId({ name: pathParsed.name, box: lastDir });
      }

      if (componentExists) {
        return addToBitMap(parsedId, [relativeFilePath], index, specs);
      }

      return addToBitMap(parsedId, [relativeFilePath], relativeFilePath, specs);
    } else { // is directory
      const pathParsed = path.parse(componentPath);
      const relativeComponentPath = getPathRelativeToProjectRoot(componentPath, consumer.getPath());
      const matches = await glob(path.join(relativeComponentPath, '**'), { cwd: consumer.getPath(), nodir: true });
      if (!matches.length) throw new Error(`The directory ${relativeComponentPath} is empty, nothing to add`);
      if (!id && matches.length > 1) {
        throw new Error('Please specify the ID of your component. It can\'t be concluded by the file-name as your directory has many files');
      }
      let indexFileName = index;
      if (!index) {
        indexFileName = matches.length === 1 ? matches[0] : DEFAULT_INDEX_NAME;
      }

      const parsedFileName = path.parse(indexFileName);
      if (!parsedId) {
        parsedId = new BitId({ name: parsedFileName.name, box: pathParsed.name });
      }
      return addToBitMap(parsedId, matches, indexFileName, specs);
    }
  }

  if (componentPaths.length > 1 && id) {
    throw new Error('When specifying more than one path, the ID is automatically generated by combining the directory and file names');
  }

  const consumer: Consumer = await loadConsumer();
  const bitMap = await BitMap.load(consumer.getPath());

  const added = await Promise
    .all(componentPaths.map(componentPath => addBitMapRecords(componentPath, bitMap, consumer)));

  await bitMap.write();

  // todo: return also the files added
  return added;
}
