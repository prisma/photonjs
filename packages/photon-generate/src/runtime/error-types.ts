import { DMMF } from './dmmf-types'

export interface ArgError {
  path: string[]
  error: InvalidArgError
}

export interface FieldError {
  path: string[]
  error: InvalidFieldError
}

export type InvalidFieldError = InvalidFieldNameError | InvalidFieldTypeError

export interface InvalidFieldTypeError {
  type: 'invalidFieldType'
  modelName: string
  fieldName: string
  providedValue: any
}

export interface InvalidFieldNameError {
  type: 'invalidFieldName'
  modelName: string
  didYouMean?: string
  providedName: string
}

export type JavaScriptPrimitiveType = 'number' | 'string' | 'boolean'

export type InvalidArgError =
  | InvalidArgNameError
  | MissingArgError
  | InvalidArgTypeError
  | AtLeastOneError
  | AtMostOneError

/**
 * This error occurs if the user provides an arg name that doens't exist
 */
export type InvalidArgNameError = {
  type: 'invalidName'
  providedName: string
  providedValue: any
  didYouMeanArg?: string // if the possible names are too different and therefore just arbitrary, we don't suggest anything
  didYouMeanField?: string // if it's very similar to a field, they probably just forgot the select statement
  originalType: DMMF.ArgType
  possibilities?: DMMF.ArgType[]
  outputType?: DMMF.OutputType
}

/**
 * Opposite of InvalidArgNameError - if the user *doesn't* provide an arg that should be provided
 * This error both happens with an implicit and explicit `undefined`
 */
export type MissingArgError = {
  type: 'missingArg'
  missingName: string
  missingType: DMMF.ArgType[] // note that this could be an object or scalar type. in the object case, we print the whole object type
  isScalar: boolean // useful for error printing
  isEnum: boolean
  isList: boolean
  isRequired: boolean
  atLeastOne: boolean
  atMostOne: boolean
}

export type AtMostOneError = {
  type: 'atMostOne'
  key: string
  inputType: DMMF.InputType
  providedKeys: string[]
}

export type AtLeastOneError = {
  type: 'atLeastOne'
  key: string
  inputType: DMMF.InputType
}

/**
 * If the scalar type of an arg is not matching what is required
 */
export type InvalidArgTypeError = {
  type: 'invalidType'
  argName: string
  requiredType: {
    bestFittingType: DMMF.ArgType
    types: DMMF.ArgType[]
    isRequired: boolean
    isScalar: boolean
    isEnum: boolean
    isList: boolean
  }
  providedValue: any
}
